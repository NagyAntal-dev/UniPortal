// ============================================================
// echo-receipt — a visszaigazoló levél sablonja (magyar / angol)
//
// A váz SZÁNDÉKOSAN ugyanaz, mint a deploy/web/email/confirmation.html-é
// (háttér, kártya, felső csík, NJE | UNIPORTAL fejléc, gomb, lábléc) — ha
// ott változik az arculat, itt is kövesse. Azok a GoTrue Go-sablonjai, ez
// viszont TypeScript, mert ezt a levelet nem a GoTrue küldi.
//
// NYELV: 'hu' vagy 'en' → egynyelvű levél; bármi más → kétnyelvű (magyar
// elöl), pontosan úgy, mint a regisztrációs levélnél.
//
// A levél NEM tartalmaz se választ, se időpontot: csak azt igazolja, hogy a
// hallgató kitöltötte a kérdőívet. Lásd az index.ts fejlécét.
// ============================================================

export type ReceiptInput = {
  lang: 'hu' | 'en' | null;
  courseName: string;
  courseNameEn: string;
  courseCode: string;
  campaignName: string;
  siteUrl: string;
};

const esc = (s: string) =>
  String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// A kurzus megnevezése: "Név (KÓD)", ha van kód.
const courseLabel = (name: string, code: string) => (code ? `${name} (${code})` : name);

const H1 = 'margin: 0 0 8px; font-size: 22px; font-weight: 900; letter-spacing: -0.02em; color: #0f172a;';
const H2 = 'margin: 0 0 8px; font-size: 18px; font-weight: 900; letter-spacing: -0.01em; color: #0f172a;';
const P  = 'margin: 0 0 24px; font-size: 14px; line-height: 1.6; color: #64748b;';

function block(lang: 'hu' | 'en', heading: 'h1' | 'h2', c: ReceiptInput, appUrl: string) {
  const hu = lang === 'hu';
  const course = esc(courseLabel(hu ? c.courseName : (c.courseNameEn || c.courseName), c.courseCode));
  const campaign = c.campaignName ? ` (${esc(c.campaignName)})` : '';
  const title = hu ? 'Köszönjük, hogy kitöltötted a kérdőívet' : 'Thank you for completing the questionnaire';
  const body = hu
    ? `Rögzítettük, hogy értékelted a(z) <strong style="color: #0f172a;">${course}</strong> kurzust${campaign}.
              A válaszaid névtelenül érkeztek be: ez a levél csak azt igazolja, hogy kitöltötted a kérdőívet, azt nem, hogy mit válaszoltál.`
    : `We have recorded that you evaluated the course <strong style="color: #0f172a;">${course}</strong>${campaign}.
              Your answers were submitted anonymously: this email only confirms that you completed the questionnaire, not what you answered.`;
  const button = hu ? 'UniPortal megnyitása' : 'Open UniPortal';
  return `
        <tr>
          <td lang="${lang}" style="padding: 24px 36px 0;">
            <${heading} style="${heading === 'h1' ? H1 : H2}">${title}</${heading}>
            <p style="${P}">
              ${body}
            </p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td align="center" bgcolor="#b85200" style="background: #b85200; border-radius: 16px;">
                  <a href="${esc(appUrl)}" style="display: block; padding: 14px 22px; font-size: 14px; font-weight: 700; color: #ffffff; text-decoration: none;">${button}</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>`;
}

function textBlock(lang: 'hu' | 'en', c: ReceiptInput, appUrl: string) {
  const hu = lang === 'hu';
  const course = courseLabel(hu ? c.courseName : (c.courseNameEn || c.courseName), c.courseCode);
  const campaign = c.campaignName ? ` (${c.campaignName})` : '';
  return hu
    ? `Köszönjük, hogy kitöltötted a kérdőívet!\n\n` +
      `Rögzítettük, hogy értékelted a(z) ${course} kurzust${campaign}. ` +
      `A válaszaid névtelenül érkeztek be: ez a levél csak azt igazolja, hogy kitöltötted a kérdőívet, azt nem, hogy mit válaszoltál.\n\n` +
      `UniPortal: ${appUrl}`
    : `Thank you for completing the questionnaire!\n\n` +
      `We have recorded that you evaluated the course ${course}${campaign}. ` +
      `Your answers were submitted anonymously: this email only confirms that you completed the questionnaire, not what you answered.\n\n` +
      `UniPortal: ${appUrl}`;
}

export function renderReceipt(c: ReceiptInput): { subject: string; html: string; text: string } {
  const hu = c.lang !== 'en';
  const en = c.lang !== 'hu';
  const both = hu && en;
  const sep = (a: string, b: string) => (both ? `${a} · ${b}` : hu ? a : b);

  const base = c.siteUrl.replace(/\/+$/, '');
  const appUrl = `${base}/app.html`;

  const subject = sep('Kérdőív kitöltve', 'Questionnaire completed') + ' — UniPortal';
  const preheader = sep('Rögzítettük, hogy kitöltötted a kérdőívet', 'Your questionnaire has been recorded');

  const html = `<div style="display: none; max-height: 0; overflow: hidden; mso-hide: all;">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#fff9f2" style="background: #fff9f2; font-family: Inter, 'Segoe UI', Arial, sans-serif;">
  <tr>
    <td align="center" style="padding: 32px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="max-width: 520px; background: #ffffff; border: 1px solid #ffdcb3; border-radius: 24px; border-collapse: separate; overflow: hidden;">
        <tr><td height="6" bgcolor="#d06700" style="height: 6px; background: #d06700; font-size: 0; line-height: 0;">&nbsp;</td></tr>
        <tr>
          <td style="padding: 32px 36px 8px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="font-size: 20px; font-weight: 900; letter-spacing: -0.02em; color: #b85200;">NJE</td>
                <td style="padding: 0 10px;"><div style="width: 1px; height: 22px; background: #e2e8f0;"></div></td>
                <td style="font-size: 11px; font-weight: 900; letter-spacing: 0.16em; color: #0f172a;">UNIPORTAL</td>
              </tr>
            </table>
          </td>
        </tr>${hu ? block('hu', 'h1', c, appUrl) : ''}${both ? `
        <tr><td style="padding: 28px 36px 4px;"><div style="height: 1px; background: #f1f5f9; font-size: 0; line-height: 0;">&nbsp;</div></td></tr>` : ''}${en ? block('en', hu ? 'h2' : 'h1', c, appUrl) : ''}
        <tr><td style="padding: 0 0 32px; font-size: 0; line-height: 0;">&nbsp;</td></tr>
      </table>

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width: 520px;">
        <tr>
          <td align="center" style="padding: 20px 16px 0; font-size: 11px; line-height: 1.7; font-weight: 600; color: #94a3b8;">
            ${sep('Neumann János Egyetem', 'John von Neumann University')}<br />
            <a href="${esc(base)}/privacy.html" style="color: #94a3b8; text-decoration: underline;">${sep('Adatkezelési tájékoztató', 'Privacy')}</a> ·
            <a href="${esc(base)}/terms.html" style="color: #94a3b8; text-decoration: underline;">${sep('Felhasználási feltételek', 'Terms')}</a>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
`;

  const text = [hu ? textBlock('hu', c, appUrl) : '', en ? textBlock('en', c, appUrl) : '']
    .filter(Boolean).join('\n\n———\n\n');

  return { subject, html, text };
}
