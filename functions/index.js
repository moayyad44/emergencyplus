const { onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();

// ================= أسرار واتساب (تُضبط عبر: firebase functions:secrets:set WHATSAPP_TOKEN وWHATSAPP_PHONE_NUMBER_ID) =================
// لا تُكتب القيم الحقيقية هنا مباشرة إطلاقاً — Firebase يخزّنها بشكل مشفّر منفصل عن الكود.
const WHATSAPP_TOKEN = defineSecret('WHATSAPP_TOKEN');
const WHATSAPP_PHONE_NUMBER_ID = defineSecret('WHATSAPP_PHONE_NUMBER_ID');

// اسم قالب الرسالة المعتمد من Meta (Business Manager → WhatsApp Manager → Message Templates)
// يجب إنشاؤه واعتماده من Meta قبل أي إرسال فعلي — راجع WHATSAPP_SETUP.md لنص القالب المقترح بالضبط
const TEMPLATE_NAME = 'invoice_payment_receipt';
const TEMPLATE_LANGUAGE = 'ar';

// رابط تقييم العيادة (رابط تقييم جوجل مثلاً) — عدّله لرابط العيادة الفعلي قبل النشر
const REVIEW_LINK = 'https://g.page/r/REPLACE_WITH_REAL_GOOGLE_REVIEW_LINK/review';

// ================= أدوات مساعدة =================

// نفس منطق "المبلغ المطلوب من المريض" الموجود بالتطبيق (index.html: patientDueAmount) —
// لفاتورة التأمين نُرسل تحمّل المريض فقط، لا إجمالي الفاتورة الذي يشمل تحمّل شركة التأمين أيضاً
function patientDueAmount(invoice) {
  return invoice.insurance_company ? (invoice.insurance_patient_share || 0) : (invoice.total || 0);
}

// يحوّل رقم أردني محلي (07XXXXXXXX) إلى الصيغة الدولية التي تتطلبها واتساب (962XXXXXXXXX بلا صفر بادئ وبلا علامة +)
function toWhatsAppPhone(localPhone) {
  const digits = String(localPhone || '').replace(/\D/g, '');
  if (digits.startsWith('962')) return digits;
  if (digits.startsWith('0')) return '962' + digits.slice(1);
  return null; // صيغة غير معروفة — لا نخمّن، نتجاهل الإرسال بدل إرسال لرقم خاطئ
}

async function findPatientPhone(patientId) {
  if (!patientId) return null;
  const doc = await db.collection('ep_store').doc('patients').get();
  const patients = (doc.exists && doc.data().value) || [];
  const patient = patients.find((p) => p.id === patientId);
  return patient ? patient.phone : null;
}

async function sendWhatsAppTemplateMessage({ toPhone, patientName, amount, token, phoneNumberId }) {
  const url = `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`;
  const body = {
    messaging_product: 'whatsapp',
    to: toPhone,
    type: 'template',
    template: {
      name: TEMPLATE_NAME,
      language: { code: TEMPLATE_LANGUAGE },
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: patientName || 'عزيزنا المريض' },
            { type: 'text', text: amount.toFixed(2) },
            { type: 'text', text: REVIEW_LINK }
          ]
        }
      ]
    }
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`WhatsApp API error (${res.status}): ${JSON.stringify(json)}`);
  }
  return json;
}

// ================= الدالة الرئيسية =================
// تُطلَق تلقائياً عند أي تعديل على مستند فاتورة بمجموعة ep_invoices، وتُرسل رسالة واتساب فقط
// عند انتقال الفاتورة فعلياً من "غير مدفوعة" إلى "مدفوعة" (لا عند أي تعديل آخر)
exports.sendPaymentWhatsAppMessage = onDocumentUpdated(
  {
    document: 'ep_invoices/{invoiceId}',
    secrets: [WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID],
    region: 'us-central1'
  },
  async (event) => {
    const before = event.data.before.data();
    const after = event.data.after.data();

    // نهتم فقط بلحظة التحصيل الفعلي: false -> true تحديداً
    if (before.paid || !after.paid) return;

    // حماية من إعادة الإرسال عند إعادة محاولة تلقائية للدالة نفسها (retry) على نفس الحدث
    if (after.whatsapp_notified) return;

    // الفاتورة السريعة IM لا ترتبط بمريض مسجَّل (patient_id فارغ) ولا رقم هاتف محفوظ — لا يوجد لمن نُرسل
    const phoneRaw = await findPatientPhone(after.patient_id);
    const toPhone = toWhatsAppPhone(phoneRaw);
    if (!toPhone) {
      logger.info(`لا يوجد رقم هاتف صالح لإرسال واتساب للفاتورة ${event.params.invoiceId} — تخطّي`);
      return;
    }

    const amount = patientDueAmount(after);
    if (amount <= 0) return; // لا معنى لإرسال إشعار دفع لمبلغ صفر

    try {
      await sendWhatsAppTemplateMessage({
        toPhone,
        patientName: after.patient_name,
        amount,
        token: WHATSAPP_TOKEN.value(),
        phoneNumberId: WHATSAPP_PHONE_NUMBER_ID.value()
      });
      await event.data.after.ref.update({ whatsapp_notified: true, whatsapp_notified_at: admin.firestore.FieldValue.serverTimestamp() });
      logger.info(`تم إرسال رسالة واتساب بنجاح للفاتورة ${event.params.invoiceId}`);
    } catch (err) {
      // لا نمنع حفظ الفاتورة أو نُفشل أي شيء بالتطبيق — فقط نسجّل الخطأ لمراجعته لاحقاً
      logger.error(`فشل إرسال واتساب للفاتورة ${event.params.invoiceId}: ${err.message}`);
    }
  }
);
