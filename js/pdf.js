// PDF report generation (jsPDF + embedded DejaVu Sans font for Polish diacritics).

const PDF_MARGIN = 15;
const PDF_PAGE_W = 210;
const PDF_PAGE_H = 297;
const PDF_FOOTER_SPACE = 14;
const PDF_LINE_H = 5;

function createPdfDoc() {
  const doc = new jspdf.jsPDF({ unit: 'mm', format: 'a4' });
  doc.addFileToVFS(PDF_FONT_DEJAVU.normalName, PDF_FONT_DEJAVU.normalB64);
  doc.addFont(PDF_FONT_DEJAVU.normalName, 'DejaVuSans', 'normal');
  doc.addFileToVFS(PDF_FONT_DEJAVU.boldName, PDF_FONT_DEJAVU.boldB64);
  doc.addFont(PDF_FONT_DEJAVU.boldName, 'DejaVuSans', 'bold');
  doc.setFont('DejaVuSans', 'normal');
  return doc;
}

function pdfEnsureSpace(doc, y, needed) {
  if (y + needed > PDF_PAGE_H - PDF_FOOTER_SPACE) {
    doc.addPage();
    return PDF_MARGIN;
  }
  return y;
}

// columns: [{ header, width, align }]  rows: array of arrays of strings
function pdfDrawTable(doc, startY, columns, rows) {
  let y = startY;
  const totalWidth = columns.reduce((s, c) => s + c.width, 0);
  const cellPad = 1.5;

  function drawHeader() {
    doc.setFont('DejaVuSans', 'bold');
    doc.setFontSize(8.5);
    doc.setFillColor(37, 99, 235);
    doc.setTextColor(255, 255, 255);
    doc.rect(PDF_MARGIN, y, totalWidth, 7, 'F');
    let x = PDF_MARGIN;
    for (const col of columns) {
      doc.text(col.header, x + cellPad, y + 4.8);
      x += col.width;
    }
    y += 7;
    doc.setTextColor(31, 35, 40);
    doc.setFont('DejaVuSans', 'normal');
  }

  y = pdfEnsureSpace(doc, y, 7);
  drawHeader();

  doc.setFontSize(8.3);
  let zebra = false;
  for (const row of rows) {
    const wrapped = row.map((cell, i) => doc.splitTextToSize(String(cell), columns[i].width - cellPad * 2));
    const lineCount = Math.max(...wrapped.map((w) => w.length), 1);
    const rowHeight = Math.max(6, lineCount * PDF_LINE_H + 1);

    if (y + rowHeight > PDF_PAGE_H - PDF_FOOTER_SPACE) {
      doc.addPage();
      y = PDF_MARGIN;
      drawHeader();
      doc.setFontSize(8.3);
    }

    if (zebra) {
      doc.setFillColor(245, 246, 248);
      doc.rect(PDF_MARGIN, y, totalWidth, rowHeight, 'F');
    }
    zebra = !zebra;

    let x = PDF_MARGIN;
    for (let i = 0; i < columns.length; i++) {
      doc.text(wrapped[i], x + cellPad, y + 4, { maxWidth: columns[i].width - cellPad * 2 });
      x += columns[i].width;
    }
    y += rowHeight;
  }

  doc.setDrawColor(225, 228, 232);
  doc.rect(PDF_MARGIN, startY, totalWidth, y - startY);
  return y;
}

function pdfFormatDate(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

function generatePdfReport(scopedEntries, from, to) {
  const doc = createPdfDoc();
  let y = PDF_MARGIN;

  doc.setFont('DejaVuSans', 'bold');
  doc.setFontSize(16);
  doc.text('Raport czasu pracy', PDF_MARGIN, y);
  y += 7;

  doc.setFont('DejaVuSans', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(87, 96, 106);
  doc.text(`Zakres: ${pdfFormatDate(from)} – ${pdfFormatDate(to)}`, PDF_MARGIN, y);
  y += 5;
  const now = new Date();
  const generatedAt = `${pad2(now.getDate())}.${pad2(now.getMonth() + 1)}.${now.getFullYear()} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  doc.text(`Wygenerowano: ${generatedAt}`, PDF_MARGIN, y);
  doc.setTextColor(31, 35, 40);
  y += 9;

  const workEntries = scopedEntries.filter((e) => e.type === 'work' || e.type === 'leave');
  const tripEntries = scopedEntries.filter((e) => e.type === 'trip');

  if (workEntries.length > 0) {
    doc.setFont('DejaVuSans', 'bold');
    doc.setFontSize(12);
    doc.text('Dni pracy i urlop z nadgodzin', PDF_MARGIN, y);
    y += 5;

    const columns = [
      { header: 'Data', width: 22 },
      { header: 'Dzień', width: 14 },
      { header: 'Typ', width: 16 },
      { header: 'Godz.', width: 16 },
      { header: 'Std.', width: 16 },
      { header: 'N.godz.', width: 20 },
      { header: 'Notatka', width: 76 },
    ];
    const rows = workEntries.map((entry) => {
      const r = computeEntry(entry);
      return [
        pdfFormatDate(entry.date),
        dayOfWeekName(entry.date, true),
        entry.type === 'leave' ? 'Urlop' : 'Praca',
        entry.type === 'leave' ? '–' : entry.hours.toFixed(2),
        entry.type === 'leave' ? '–' : r.standard.toFixed(2),
        entry.type === 'leave' ? `-${entry.hours.toFixed(2)}` : (r.overtime > 0 ? `+${r.overtime.toFixed(2)}` : '–'),
        entry.note || '',
      ];
    });
    y = pdfDrawTable(doc, y, columns, rows);
    y += 8;
  }

  if (tripEntries.length > 0) {
    y = pdfEnsureSpace(doc, y, 14);
    doc.setFont('DejaVuSans', 'bold');
    doc.setFontSize(12);
    doc.text('Delegacje (podróże służbowe)', PDF_MARGIN, y);
    y += 5;

    const columns = [
      { header: 'Od', width: 22 },
      { header: 'Do', width: 22 },
      { header: 'Dni', width: 10 },
      { header: 'Cel', width: 46 },
      { header: 'Dieta/d.', width: 22 },
      { header: 'Suma', width: 22 },
      { header: 'Notatka', width: 36 },
    ];
    const rows = tripEntries.map((entry) => {
      const r = computeEntry(entry);
      return [
        pdfFormatDate(entry.date),
        pdfFormatDate(entryEndDate(entry)),
        String(r.tripDays),
        entry.destination || '',
        formatMoney(entry.dailyAllowance || 0),
        formatMoney(r.tripAllowance),
        entry.note || '',
      ];
    });
    y = pdfDrawTable(doc, y, columns, rows);
    y += 8;
  }

  if (workEntries.length === 0 && tripEntries.length === 0) {
    doc.setFont('DejaVuSans', 'normal');
    doc.setFontSize(10);
    doc.text('Brak wpisów w wybranym zakresie dat.', PDF_MARGIN, y);
    y += 8;
  }

  // Summary box
  const s = summarize(scopedEntries);
  y = pdfEnsureSpace(doc, y, 40);
  doc.setFont('DejaVuSans', 'bold');
  doc.setFontSize(12);
  doc.text('Podsumowanie', PDF_MARGIN, y);
  y += 6;

  const boxW = PDF_PAGE_W - PDF_MARGIN * 2;
  doc.setDrawColor(225, 228, 232);
  doc.setFillColor(239, 246, 255);
  const days = Math.floor(Math.abs(s.balance) / STANDARD_DAY_HOURS);
  const rem = Math.abs(s.balance) % STANDARD_DAY_HOURS;
  const balanceSign = s.balance < 0 ? '-' : '';

  const summaryLines = [
    ['Suma godzin przepracowanych:', formatHours(s.workedHours)],
    ['Nadgodziny wypracowane:', formatHours(s.earned)],
    ['Nadgodziny wykorzystane jako urlop:', formatHours(s.used)],
    ['Saldo nadgodzin na koniec okresu:', `${formatHours(s.balance)} (≈ ${balanceSign}${days} dni + ${rem.toFixed(2)} h)`],
    ['Liczba dni delegacji:', `${s.tripDays} dni`],
    ['Suma diet z delegacji:', formatMoney(s.tripAllowance)],
  ];
  const boxH = summaryLines.length * 6.5 + 6;
  doc.rect(PDF_MARGIN, y, boxW, boxH, 'FD');
  let ly = y + 6.5;
  doc.setFontSize(9.5);
  for (const [label, value] of summaryLines) {
    doc.setFont('DejaVuSans', 'normal');
    doc.text(label, PDF_MARGIN + 4, ly);
    doc.setFont('DejaVuSans', 'bold');
    doc.text(value, PDF_MARGIN + boxW - 4, ly, { align: 'right' });
    ly += 6.5;
  }

  // Footer with page numbers
  const pageCount = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFont('DejaVuSans', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(140, 148, 158);
    doc.text(`Strona ${i} z ${pageCount}`, PDF_PAGE_W / 2, PDF_PAGE_H - 8, { align: 'center' });
  }

  doc.save(`raport-nadgodziny_${from}_${to}.pdf`);
}
