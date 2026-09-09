// Builds a minimal, valid one-page PDF entirely in memory -- no library,
// no network fetch, no file system. Byte-level PDF construction (the
// classic "hello world PDF" object layout: catalog -> pages -> page ->
// content stream + a Helvetica font, base14 so no font file is needed).
// This exists specifically so "Add to Curatal" never touches a download or
// the local disk: build bytes, base64-encode, upload -- done.
//
// Deliberately not a copy of the actual LinkedIn page -- it's a plain-text
// summary of what the content script scraped (name/title/company/URL).
// PDF string literals only support Latin-1 bytes, so anything outside that
// range is replaced with "?" rather than producing a corrupt file.
function escapePdfText(text) {
  return String(text || '')
    .replace(/[^\x00-\xFF]/g, '?')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function buildProfileSummaryPdf({ fullName, title, company, linkedinUrl }) {
  const lines = [
    title || company ? `${title || 'Unknown role'} at ${company || 'Unknown employer'}` : '',
    linkedinUrl || '',
    '',
    `Captured via Curatal LinkedIn Candidate Checker on ${new Date().toISOString().slice(0, 10)}`,
  ].filter(Boolean);

  const lineHeight = 18;
  const startY = 740;
  const streamLines = [`BT /F1 16 Tf 50 770 Td (${escapePdfText(fullName || 'Unknown candidate')}) Tj ET`];
  lines.forEach((line, i) => {
    streamLines.push(`BT /F1 11 Tf 50 ${startY - i * lineHeight} Td (${escapePdfText(line)}) Tj ET`);
  });
  const contentStream = streamLines.join('\n');

  // Objects 1-5: Catalog, Pages, Page, Contents (stream), Font. Indices
  // below are 0-based into this array but PDF object numbers are 1-based.
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${contentStream.length} >>\nstream\n${contentStream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((obj, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((offset) => {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  // pdf is a binary-safe Latin-1 string (every char code is 0-255, since
  // all inputs were sanitized above and the PDF syntax itself is ASCII) --
  // btoa() can base64-encode it directly.
  return `data:application/pdf;base64,${btoa(pdf)}`;
}
