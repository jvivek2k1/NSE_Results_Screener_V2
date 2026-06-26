// Indian fiscal-quarter helpers.
// FY runs Apr-Mar. Q1=Apr-Jun, Q2=Jul-Sep, Q3=Oct-Dec, Q4=Jan-Mar.

export function quarterIndexToLabel(index) {
  // index = fiscalYear*4 + (q-1), q in 1..4
  const q = (index % 4) + 1;
  const fy = Math.floor(index / 4);
  const fyShort = String(fy).slice(-2);
  return `Q${q} FY${fyShort}`;
}

export function labelToQuarterIndex(label) {
  const m = /Q(\d)\s*FY(\d{2,4})/i.exec(label);
  if (!m) return 0;
  const q = parseInt(m[1], 10);
  let fy = parseInt(m[2], 10);
  if (fy < 100) fy += 2000;
  return fy * 4 + (q - 1);
}

// Current fiscal quarter index based on a date.
export function currentQuarterIndex(date = new Date()) {
  const month = date.getMonth(); // 0-11
  const year = date.getFullYear();
  let q, fy;
  if (month >= 3 && month <= 5) {
    q = 1;
    fy = year + 1; // FY label is the ending year
  } else if (month >= 6 && month <= 8) {
    q = 2;
    fy = year + 1;
  } else if (month >= 9 && month <= 11) {
    q = 3;
    fy = year + 1;
  } else {
    q = 4;
    fy = year; // Jan-Mar belongs to FY ending this year
  }
  return fy * 4 + (q - 1);
}

export function prevQuarterIndex(index, n = 1) {
  return index - n;
}

// The last calendar day of the fiscal quarter represented by `index`.
// Q1->Jun 30, Q2->Sep 30, Q3->Dec 31 of the prior calendar year; Q4->Mar 31
// of the FY-ending year. Returns a UTC Date.
export function quarterIndexToPeriodEnd(index) {
  const q = (index % 4) + 1; // 1..4
  const fy = Math.floor(index / 4); // FY label = ending calendar year
  // [month index, day] for the quarter end; year offset relative to fy.
  const ends = [
    [5, 30, -1], // Q1 -> Jun 30 (fy-1)
    [8, 30, -1], // Q2 -> Sep 30 (fy-1)
    [11, 31, -1], // Q3 -> Dec 31 (fy-1)
    [2, 31, 0], // Q4 -> Mar 31 (fy)
  ];
  const [month, day, yearOffset] = ends[q - 1];
  return new Date(Date.UTC(fy + yearOffset, month, day, 23, 59, 59));
}
