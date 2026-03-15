'use strict';

/* ═══════════════════════════════════════════════════════════════════
   STATE
   ═══════════════════════════════════════════════════════════════════ */
const state = {
  mode: 'glucose',      // 'glucose' | 'generic'
  lambda: 505,

  // Calibration
  calibrated:  false,

  // Triplicate standard
  triplicateAttempt: 0,       // 0=not started, increments on each reading attempt
  triplicateReadings: [],     // [{ label, abs, pctT, included }]
  triplicateMean:  null,
  triplicateSD:    null,
  triplicateCV:    null,
  triplicateFailedAttempts: [], // [{ attempt, readings, cv, mean }] — saved on each retry

  fator:         null,
  fatorAccepted: false,

  // Generic mode
  analyteName: 'Proteína Total',
  stdConc:     100,
  unit:        'g/dL',

  // Results
  results:     [],
  sampleCount: 0,

  // Calibration curves
  generatedCurves:    [],
  selectedCurveLabel: null,
};

/* ═══════════════════════════════════════════════════════════════════
   CONSTANTS
   ═══════════════════════════════════════════════════════════════════ */
const WAVELENGTHS  = [340, 405, 505, 540, 546, 570, 620, 670];
const STD_POINTS   = [0, 25, 50, 100, 150, 200]; // calibration curve concentrations
const CV_THRESHOLD = 1.0;  // % — max acceptable CV for triplicate (clinical standard)

// Approximate molar absorptivity per wavelength (simulated)
const EPSILON_MAP = {
  340: 0.00320, 405: 0.00280, 505: 0.00312,
  540: 0.00290, 546: 0.00305, 570: 0.00270,
  620: 0.00185, 670: 0.00160,
};

/* ═══════════════════════════════════════════════════════════════════
   INIT
   ═══════════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  buildLambdaGrid();
  setLambda(505);
  setLedState('red');
  renderTable();

  // Live sync generic fields
  ['genericAnalyte', 'genericUnit', 'genericStd'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', () => { syncGenericFields(); resetCalibration(); });
  });
});

/* ═══════════════════════════════════════════════════════════════════
   LAMBDA
   ═══════════════════════════════════════════════════════════════════ */
function buildLambdaGrid() {
  const grid = document.getElementById('lambdaGrid');
  grid.innerHTML = '';
  WAVELENGTHS.forEach(nm => {
    const btn = document.createElement('button');
    btn.className = 'lambda-btn';
    btn.textContent = nm;
    btn.id = `lbtn-${nm}`;
    btn.onclick = () => { if (!btn.disabled) { setLambda(nm); resetCalibration(); } };
    grid.appendChild(btn);
  });
}

function setLambda(nm) {
  state.lambda = nm;
  document.getElementById('lambdaDisplay').textContent = `λ: ${nm} nm`;
  document.querySelectorAll('.lambda-btn').forEach(b => {
    b.classList.toggle('active', parseInt(b.textContent) === nm);
  });
}

function lockLambda(locked) {
  document.querySelectorAll('.lambda-btn').forEach(b => {
    b.disabled = locked;
    b.style.opacity = locked ? '0.35' : '';
    b.style.cursor  = locked ? 'not-allowed' : '';
  });
}

/* ═══════════════════════════════════════════════════════════════════
   MODE
   ═══════════════════════════════════════════════════════════════════ */
function setMode(mode, tabEl) {
  state.mode = mode;

  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  tabEl.classList.add('active');

  const gf = document.getElementById('genericFields');

  if (mode === 'glucose') {
    gf.classList.add('hidden');
    setLambda(505);
    lockLambda(true);
  } else {
    gf.classList.remove('hidden');
    lockLambda(false);
    syncGenericFields();
  }

  resetCalibration();
}

function syncGenericFields() {
  state.analyteName = document.getElementById('genericAnalyte').value || 'Analito';
  state.stdConc     = parseFloat(document.getElementById('genericStd').value) || 100;
  state.unit        = document.getElementById('genericUnit').value || 'u';
}

/* ═══════════════════════════════════════════════════════════════════
   CALIBRATION — BLANK
   ═══════════════════════════════════════════════════════════════════ */
function doBlanco() {
  setLedState('yellow', 'Zerando…');

  setTimeout(() => {
    state.calibrated             = true;
    state.fator                  = null;
    state.fatorAccepted          = false;
    state.triplicateAttempt      = 0;
    state.triplicateReadings     = [];
    state.triplicateFailedAttempts = [];

    setLedState('green', 'Pronto');
    setDisplay(0.0000, 100.0, null, null);
    document.getElementById('btnLerPadrao').disabled   = false;
    document.getElementById('btnLerAmostra').disabled  = true;
    document.getElementById('fatorCallout').classList.remove('visible');
    document.getElementById('triplicateSection').classList.add('hidden');
    setStatus('Aparelho zerado. Leia o padrão (triplicata).', 'ok');
  }, 600);
}

/* ═══════════════════════════════════════════════════════════════════
   CALIBRATION — TRIPLICATE STANDARD
   ═══════════════════════════════════════════════════════════════════ */
/* Normal distribution sample via Box-Muller */
function randn() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/* Quick CV calc on raw readings array */
function quickCV(readings) {
  const vals = readings.map(r => r.abs);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  if (vals.length < 2 || mean === 0) return 0;
  const sd = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / (vals.length - 1));
  return (sd / mean) * 100;
}

/* Build one set of 3 readings at a given noise sigma (fraction of baseAbs) */
function makeReadings(baseAbs, sigma) {
  return [0, 1, 2].map((_, idx) => {
    const abs  = Math.max(0.0001, baseAbs + randn() * baseAbs * sigma);
    const pctT = 100 * Math.pow(10, -abs);
    return { label: `P${idx + 1}`, abs, pctT, included: true };
  });
}

function doLerPadrao() {
  if (!state.calibrated) { setStatus('Calibre com BRANCO primeiro.', 'err'); return; }
  if (state.mode === 'generic') syncGenericFields();

  setLedState('yellow', 'Lendo…');
  setTimeout(() => {
    state.triplicateAttempt++;

    const baseAbs = getStdConc() * getEpsilon();

    // 20% chance of elevated CV on the first attempt (CV 1–6%); retries are always clean
    const wantHighCV = state.triplicateAttempt === 1 && Math.random() < 0.20;

    let readings;
    let iters = 0;

    if (wantHighCV) {
      // sigma scaled so expected CV lands between ~1% and ~6%
      const sigma = 0.013 + Math.random() * 0.045;
      do {
        readings = makeReadings(baseAbs, sigma);
        iters++;
      } while (quickCV(readings) <= CV_THRESHOLD && iters < 30);
    } else {
      // Clean reading: target sigma ≈ 0.3% → CV well below 1%
      do {
        readings = makeReadings(baseAbs, 0.003);
        iters++;
      } while (quickCV(readings) > CV_THRESHOLD && iters < 30);
    }

    state.triplicateReadings = readings;
    setLedState('green', 'Pronto');

    renderTriplicate();
    updateTriplicateCalc();

    document.getElementById('triplicateSection').classList.remove('hidden');
    setStatus('Triplicata gerada. Verifique as leituras e aceite.', '');
  }, 700);
}

function renderTriplicate() {
  const container = document.getElementById('triplicateReadings');
  container.innerHTML = '';

  state.triplicateReadings.forEach((r, i) => {
    const row = document.createElement('div');
    row.className = 'tripl-reading' + (r.included ? '' : ' excluded');
    row.id = `tripl-row-${i}`;

    const deviation = detectDeviation(i);

    row.innerHTML = `
      <span class="tripl-reading-label">${r.label}</span>
      <span class="tripl-reading-abs">${r.abs.toFixed(4)} Abs</span>
      <span class="tripl-reading-pct">${r.pctT.toFixed(1)} %T</span>
      <span class="tripl-reading-warn">${deviation ? '⚠' : ''}</span>
      <button class="tripl-toggle ${r.included ? 'include' : 'exclude'}"
              onclick="toggleTriplicateReading(${i})">
        ${r.included ? '✓ Incluir' : '✗ Rejeitado'}
      </button>
    `;
    container.appendChild(row);
  });
}

function detectDeviation(idx) {
  // Warn if this reading deviates > 10% from the median of all 3
  const vals = state.triplicateReadings.map(r => r.abs);
  const sorted = [...vals].sort((a, b) => a - b);
  const median = sorted[1]; // middle value of 3
  return Math.abs(vals[idx] - median) / median > 0.10;
}

function toggleTriplicateReading(i) {
  state.triplicateReadings[i].included = !state.triplicateReadings[i].included;
  renderTriplicate();
  updateTriplicateCalc();
}

function updateTriplicateCalc() {
  const included = state.triplicateReadings.filter(r => r.included);
  const calcBox  = document.getElementById('triplicateCalc');
  const statusEl = document.getElementById('triplicateStatus');
  const acceptBtn = document.getElementById('btnAceitarTripl');

  if (included.length === 0) {
    calcBox.innerHTML = '<div class="calc-line"><span class="calc-key">Aviso</span><span class="calc-expr" style="color:var(--danger)">Inclua pelo menos uma leitura.</span></div>';
    acceptBtn.disabled = true;
    statusEl.textContent = '';
    statusEl.className = 'tripl-status';
    return;
  }

  const mean = included.reduce((s, r) => s + r.abs, 0) / included.length;

  let sd = 0;
  if (included.length > 1) {
    const variance = included.reduce((s, r) => s + Math.pow(r.abs - mean, 2), 0) / (included.length - 1);
    sd = Math.sqrt(variance);
  }

  const cv = included.length > 1 ? (sd / mean) * 100 : 0;

  state.triplicateMean = mean;
  state.triplicateSD   = sd;
  state.triplicateCV   = cv;

  const stdConc  = getStdConc();
  const unit     = getUnit();
  const fator    = stdConc / mean;
  // CV badge: excellent ≤ 0.5% | borderline 0.5–1.0% | failed > 1.0%
  const cvBadge = cv <= 0.5 ? 'ok' : cv <= CV_THRESHOLD ? 'warn' : 'bad';
  const cvLabel = cv <= 0.5 ? 'Excelente' : cv <= CV_THRESHOLD ? 'No limite' : 'Reprovado';

  // Build expression string
  const labels  = included.map(r => r.label);
  const absVals = included.map(r => r.abs.toFixed(4));
  const mediaExpr = included.length === 1
    ? absVals[0]
    : `(${absVals.join(' + ')}) / ${included.length}`;

  calcBox.innerHTML = `
    <div class="calc-line">
      <span class="calc-key">Incluídos</span>
      <span class="calc-expr">${labels.join(', ')} (N = ${included.length})</span>
    </div>
    <div class="calc-line">
      <span class="calc-key">Média</span>
      <span class="calc-expr">${mediaExpr}</span>
      <span class="calc-result">${mean.toFixed(4)} Abs</span>
    </div>
    ${included.length > 1 ? `
    <div class="calc-line">
      <span class="calc-key">DP</span>
      <span class="calc-expr">&sigma; das leituras aceitas</span>
      <span class="calc-result">${sd.toFixed(5)}</span>
    </div>
    <div class="calc-line">
      <span class="calc-key">CV%</span>
      <span class="calc-expr">(DP / Média) × 100 &nbsp;·&nbsp; critério ≤ ${CV_THRESHOLD}%</span>
      <span class="calc-result">${cv.toFixed(2)}%
        <span class="cv-badge ${cvBadge}">${cvLabel}</span>
      </span>
    </div>` : ''}
    <div class="calc-line" style="margin-top:4px">
      <span class="calc-key">Fator</span>
      <span class="calc-expr">${stdConc} / ${mean.toFixed(4)}</span>
      <span class="calc-result">${fator.toFixed(2)} ${unit}/Abs</span>
    </div>
  `;

  const ok = cv <= CV_THRESHOLD;
  acceptBtn.disabled = !ok;

  if (cv > CV_THRESHOLD) {
    statusEl.innerHTML = `<strong>⚠ CV ${cv.toFixed(2)}% — REPROVADO</strong> (limite: ${CV_THRESHOLD}%). `
      + `Imprecisão elevada. Verifique pipetagem, bolhas na cubeta, homogeneização e temperatura. Refaça a leitura.`;
    statusEl.className = 'tripl-status err';
  } else if (cv > 0.5) {
    statusEl.textContent = `CV ${cv.toFixed(2)}% — no limite aceitável (≤ ${CV_THRESHOLD}%). Considere refazer se possível.`;
    statusEl.className = 'tripl-status warn';
  } else {
    statusEl.textContent = `CV ${cv.toFixed(2)}% — excelente precisão. Triplicata aprovada. ✓`;
    statusEl.className = 'tripl-status ok';
  }
}

function aceitarTriplicata() {
  const mean    = state.triplicateMean;
  const stdConc = getStdConc();
  const unit    = getUnit();
  const fator   = stdConc / mean;

  state.fator         = fator;
  state.fatorAccepted = true;

  const pctT = 100 * Math.pow(10, -mean);
  setDisplay(mean, pctT, stdConc, fator);
  setLedState('green', 'Pronto');

  const callout = document.getElementById('fatorCallout');
  callout.textContent = `Fator = ${stdConc} / ${mean.toFixed(4)} = ${fator.toFixed(2)} ${unit}/Abs`;
  callout.classList.add('visible');

  document.getElementById('btnLerAmostra').disabled = false;

  setStatus(`Fator de calibração: ${fator.toFixed(2)} ${unit}/Abs. Leia as amostras.`, 'ok');
  document.getElementById('triplicateStatus').textContent = 'Triplicata aceita. Fator calculado. ✓';
  document.getElementById('triplicateStatus').className = 'tripl-status ok';
  document.getElementById('btnAceitarTripl').disabled = true;
}

function refazerTriplicata() {
  // Save the current (failed) attempt before retrying
  if (state.triplicateCV !== null && state.triplicateReadings.length) {
    state.triplicateFailedAttempts.push({
      attempt:  state.triplicateAttempt,
      readings: state.triplicateReadings.map(r => ({ ...r })),
      cv:       state.triplicateCV,
      mean:     state.triplicateMean,
    });
  }
  doLerPadrao();
}

/* ═══════════════════════════════════════════════════════════════════
   SAMPLE READING
   ═══════════════════════════════════════════════════════════════════ */
function doLerAmostra() {
  if (!state.calibrated) { setStatus('Calibre com BRANCO primeiro.', 'err'); return; }
  if (!state.fatorAccepted) { setStatus('Aceite a triplicata do padrão primeiro.', 'err'); return; }
  if (state.mode === 'generic') syncGenericFields();

  setLedState('yellow', 'Lendo…');
  setTimeout(() => {
    const eps  = getEpsilon();
    const unit = getUnit();
    const conc = generateConcentration();

    const absTrue = conc * eps;
    const noise   = (Math.random() - 0.5) * absTrue * 0.008;
    const abs     = Math.max(0.0001, absTrue + noise);
    const pctT    = 100 * Math.pow(10, -abs);
    const concCalc = abs * state.fator;

    state.sampleCount++;
    state.results.push({
      n:      state.sampleCount,
      name:   `Amostra ${state.sampleCount}`,
      lambda: state.lambda,
      abs,
      pctT,
      fator: state.fator,
      conc:  concCalc,
      unit,
      mode:  state.mode,
    });

    setLedState('green', 'Pronto');
    setDisplay(abs, pctT, concCalc, state.fator);
    document.getElementById('dispUnit').textContent = unit;
    renderTable();
    setStatus(`Amostra ${state.sampleCount} registrada — ${concCalc.toFixed(1)} ${unit}`, 'ok');
  }, 450);
}

/* Glucose distribution: 70% normal (70-99), 12% hypo, 12% pre-diabetes, 6% diabetes */
function generateConcentration() {
  if (state.mode === 'glucose') {
    const r = Math.random();
    if (r < 0.70)       return 70  + Math.random() * 29;   // 70–99 (normal)
    else if (r < 0.82)  return 50  + Math.random() * 20;   // 50–69 (hypoglycemia)
    else if (r < 0.94)  return 100 + Math.random() * 26;   // 100–125 (pre-diabetes)
    else                return 126 + Math.random() * 274;   // 126–400 (diabetes)
  } else {
    const std = state.stdConc;
    return std * (0.3 + Math.random() * 1.7); // 30–200% of standard
  }
}

function classifyResult(row) {
  if (row.mode !== 'glucose') return null;
  const c = row.conc;
  if (c < 70)   return { label: 'Hipoglicemia', cls: 'hypo' };
  if (c <= 99)  return { label: 'Normal',       cls: 'normal' };
  if (c <= 125) return { label: 'Pré-diabetes', cls: 'pre' };
  return              { label: 'Diabetes',      cls: 'diab' };
}

/* ═══════════════════════════════════════════════════════════════════
   DISPLAY
   ═══════════════════════════════════════════════════════════════════ */
function setDisplay(abs, pctT, conc, fator) {
  const fmt = (v, d) => v !== null ? v.toFixed(d) : '—';
  document.getElementById('dispAbs').textContent  = fmt(abs, 4);
  document.getElementById('dispT').textContent    = fmt(pctT, 1);
  document.getElementById('dispConc').textContent = fmt(conc, 2);
  document.getElementById('dispFator').textContent = fmt(fator, 2);
  document.getElementById('dispUnit').textContent  = conc !== null ? getUnit() : '—';
  document.getElementById('dispFatorUnit').textContent = fator !== null ? getUnit() + '/Abs' : '';
}

function setStatus(msg, type) {
  const el = document.getElementById('statusMsg');
  el.textContent = msg;
  el.className = 'status-msg' + (type ? ' ' + type : '');
}

function setLedState(color, label) {
  const led = document.getElementById('led');
  const lbl = document.getElementById('ledLabel');
  led.className = 'led ' + color;
  lbl.textContent = label || (color === 'green' ? 'Pronto' : color === 'yellow' ? 'Lendo…' : 'Não calibrado');
}

/* ═══════════════════════════════════════════════════════════════════
   RESET
   ═══════════════════════════════════════════════════════════════════ */
function resetCalibration() {
  state.calibrated               = false;
  state.fator                    = null;
  state.fatorAccepted            = false;
  state.triplicateAttempt        = 0;
  state.triplicateReadings       = [];
  state.triplicateFailedAttempts = [];
  state.triplicateMean           = null;

  setLedState('red');
  setDisplay(null, null, null, null);

  document.getElementById('btnLerPadrao').disabled  = true;
  document.getElementById('btnLerAmostra').disabled = true;
  document.getElementById('fatorCallout').classList.remove('visible');
  document.getElementById('triplicateSection').classList.add('hidden');
  setStatus('Calibre o aparelho com BRANCO antes de iniciar.', '');
}

/* ═══════════════════════════════════════════════════════════════════
   RESULTS TABLE
   ═══════════════════════════════════════════════════════════════════ */
function renderTable() {
  const tbody = document.getElementById('resultsBody');

  if (!state.results.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="table-empty">Nenhuma leitura registrada.</td></tr>';
    return;
  }

  tbody.innerHTML = state.results.map(r => {
    const ref = classifyResult(r);
    const refCell = ref
      ? `<span class="ref-badge ${ref.cls}">${ref.label}</span>`
      : `<span class="ref-badge na">—</span>`;
    return `
      <tr>
        <td class="num">${r.n}</td>
        <td class="lbl">${r.name}</td>
        <td class="num">${r.lambda}</td>
        <td class="num">${r.abs.toFixed(4)}</td>
        <td class="num">${r.pctT.toFixed(1)}</td>
        <td class="num">${r.fator.toFixed(2)}</td>
        <td class="num">${r.conc.toFixed(2)}</td>
        <td class="lbl">${r.unit}</td>
        <td>${refCell}</td>
      </tr>`;
  }).join('');
}

function clearTable() {
  state.results = [];
  state.sampleCount = 0;
  renderTable();
}

function copyTable() {
  if (!state.results.length) { setStatus('Tabela vazia.', 'warn'); return; }

  const header = ['#','Amostra','λ(nm)','Abs','%T','Fator','Concentração','Unidade','Classificação'].join('\t');
  const rows = state.results.map(r => {
    const ref = classifyResult(r);
    return [r.n, r.name, r.lambda, r.abs.toFixed(4), r.pctT.toFixed(1),
            r.fator.toFixed(2), r.conc.toFixed(2), r.unit, ref ? ref.label : '—'].join('\t');
  });

  const text = [header, ...rows].join('\n');

  navigator.clipboard.writeText(text)
    .then(() => setStatus('Tabela copiada.', 'ok'))
    .catch(() => {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta);
      ta.select(); document.execCommand('copy');
      document.body.removeChild(ta);
      setStatus('Tabela copiada.', 'ok');
    });
}

/* ═══════════════════════════════════════════════════════════════════
   CALIBRATION CURVES
   ═══════════════════════════════════════════════════════════════════ */
function generateCurves() {
  state.selectedCurveLabel = null;
  const grid = document.getElementById('curvesGrid');
  grid.innerHTML = '';

  const labels = ['A', 'B', 'C', 'D'];

  // Exactly 2 bad and 2 good curves, positions fully randomised
  const positions = shuffled([0, 1, 2, 3]);
  const badSet    = new Set([positions[0], positions[1]]);
  const badTypes  = shuffled(['outlier', 'plateau', 'dispersion', 'outlier']);
  // Good curves vary slightly around the measured anchor (±1–3%)
  const goodVars  = shuffled([0.97, 0.99, 1.01, 1.03]);

  let badCount = 0, goodCount = 0;
  state.generatedCurves = [];

  labels.forEach((label, i) => {
    const isBad  = badSet.has(i);
    const points = isBad
      ? generateBadCurveSafe(badTypes[badCount++])
      : generateGoodCurveSafe(goodVars[goodCount++]);
    const { r, r2 } = calcR2(points);
    const curve = { label, points, isBad, r, r2 };
    state.generatedCurves.push(curve);
    grid.appendChild(buildCurveCard(curve));
  });
}

/**
 * Good calibration curve anchored to the measured triplicateMean.
 * @param {number} variationFactor - multiplier around the anchor (e.g. 0.97–1.03)
 *   so the two approved curves have slightly different slopes for the student to compare.
 */
function generateGoodCurve(variationFactor) {
  // Anchor: P at stdConc should produce absorbance close to state.triplicateMean
  const anchorAbs = state.triplicateMean || (getStdConc() * getEpsilon());
  const eps = (anchorAbs / getStdConc()) * variationFactor;
  return STD_POINTS.map(c => {
    const abs = Math.max(0, c * eps + (Math.random() - 0.5) * c * eps * 0.015);
    return { conc: c, abs };
  });
}

function generateBadCurve(type) {
  const eps = 0.0033;

  if (type === 'outlier') {
    const pts = generateGoodCurve(eps);
    const idx = 2 + Math.floor(Math.random() * 3); // middle points only
    pts[idx].abs = Math.max(0, pts[idx].abs * (Math.random() > 0.5 ? 1.40 : 0.65));
    return pts;

  } else if (type === 'plateau') {
    return STD_POINTS.map(c => {
      const effC = c < 100 ? c : 100 + (c - 100) * 0.12;
      const abs  = Math.max(0, effC * eps + (Math.random() - 0.5) * 0.002);
      return { conc: c, abs };
    });

  } else { // dispersion
    return STD_POINTS.map(c => {
      const base  = c * eps;
      const noise = c === 0 ? 0 : (Math.random() - 0.5) * base * 0.30;
      return { conc: c, abs: Math.max(0, base + noise) };
    });
  }
}

function calcR2(points) {
  const n = points.length;
  if (n < 2) return { r: 0, r2: 0 };
  const xs   = points.map(p => p.conc);
  const ys   = points.map(p => p.abs);
  const xbar = xs.reduce((a, b) => a + b, 0) / n;
  const ybar = ys.reduce((a, b) => a + b, 0) / n;
  let ssxy = 0, ssxx = 0, ssyy = 0;
  for (let i = 0; i < n; i++) {
    ssxy += (xs[i] - xbar) * (ys[i] - ybar);
    ssxx += (xs[i] - xbar) ** 2;
    ssyy += (ys[i] - ybar) ** 2;
  }
  if (ssxx === 0 || ssyy === 0) return { r: 0, r2: 0 };
  const r = ssxy / Math.sqrt(ssxx * ssyy);
  return { r: Math.abs(r), r2: r * r };
}

/* Wrappers that guarantee R² meets the acceptance criterion */
function generateGoodCurveSafe(variationFactor) {
  let pts, stats;
  do { pts = generateGoodCurve(variationFactor); stats = calcR2(pts); }
  while (stats.r2 < 0.995);
  return pts;
}

function generateBadCurveSafe(type) {
  let pts, stats;
  do { pts = generateBadCurve(type); stats = calcR2(pts); }
  while (stats.r2 >= 0.995);
  return pts;
}

function buildCurveCard(curve) {
  const { label, points, r2 } = curve;

  const card = document.createElement('div');
  card.className = 'curve-card';
  card.id = `curve-card-${label}`;

  const title = document.createElement('div');
  title.className = 'curve-card-title';
  title.textContent = `Curva ${label}`;
  card.appendChild(title);

  // Approval status (r / r² stay hidden until student clicks to reveal)
  const badge = document.createElement('div');
  badge.className = `r2-badge ${r2 >= 0.995 ? 'ok' : 'bad'}`;
  badge.textContent = r2 >= 0.995 ? '✓ Aprovada' : '✗ Reprovada';
  card.appendChild(badge);

  // r / r² reveal panel
  const revealWrap = document.createElement('div');
  revealWrap.className = 'r-reveal-wrap';
  revealWrap.innerHTML = `
    <button class="r-reveal-btn" onclick="revealCorr(this)">
      Analisar a correlação linear desta curva →
    </button>
    <div class="r-values hidden">
      <span>r&nbsp;=&nbsp;<strong>${curve.r.toFixed(4)}</strong></span>
      <span>r²&nbsp;=&nbsp;<strong>${r2.toFixed(4)}</strong></span>
      <span class="r-interp">${r2 >= 0.995 ? 'Correlação excelente — aprovada (r² ≥ 0,995)' : 'Correlação insuficiente — reprovada (r² < 0,995)'}</span>
    </div>`;
  card.appendChild(revealWrap);

  // Table + canvas side-by-side in a shared flex row
  const bodyRow = document.createElement('div');
  bodyRow.className = 'curve-body';

  // Points table (left side)
  const tbl = document.createElement('table');
  tbl.className = 'curve-table';
  tbl.innerHTML = `
    <thead><tr><th>Padrão</th><th>Conc.</th><th>Abs</th></tr></thead>
    <tbody>
      ${points.map((p, i) => `
        <tr>
          <td class="lbl">${i === 0 ? 'Branco' : 'P' + i}</td>
          <td class="num">${p.conc}</td>
          <td class="num">${p.abs.toFixed(4)}</td>
        </tr>`).join('')}
    </tbody>`;
  bodyRow.appendChild(tbl);

  // Canvas scatter (right side, height matches table ~7 rows ≈ 150 px)
  const canvas = document.createElement('canvas');
  canvas.className = 'scatter';
  canvas.width  = 118;
  canvas.height = 150;
  bodyRow.appendChild(canvas);

  card.appendChild(bodyRow);
  requestAnimationFrame(() => drawScatter(canvas, points, r2));

  // Select button
  const selBtn = document.createElement('button');
  selBtn.className = 'curve-select-btn';
  selBtn.id = `sel-btn-${label}`;
  selBtn.textContent = 'Selecionar para relatório';
  selBtn.onclick = (e) => { e.stopPropagation(); selectCurve(label); };
  card.appendChild(selBtn);

  card.onclick = () => selectCurve(label);

  return card;
}

function revealCorr(btn) {
  const valDiv = btn.nextElementSibling;
  const hidden = valDiv.classList.contains('hidden');
  valDiv.classList.toggle('hidden', !hidden);
  btn.textContent = hidden
    ? '▲ Ocultar correlação'
    : 'Analisar a correlação linear desta curva →';
}

function selectCurve(label) {
  state.selectedCurveLabel = label;
  document.querySelectorAll('.curve-card').forEach(c => c.classList.remove('selected'));
  document.querySelectorAll('.curve-select-btn').forEach(b => b.classList.remove('selected'));
  const card = document.getElementById(`curve-card-${label}`);
  const btn  = document.getElementById(`sel-btn-${label}`);
  if (card) card.classList.add('selected');
  if (btn)  { btn.classList.add('selected'); btn.textContent = '✓ Selecionada'; }
}

function drawScatter(canvas, points, r2 = 0) {
  const ctx  = canvas.getContext('2d');
  const W    = canvas.width, H = canvas.height;
  const pad  = { top: 8, right: 8, bottom: 20, left: 30 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#081508';
  ctx.fillRect(0, 0, W, H);

  const maxConc = 200;
  const maxAbs  = Math.max(...points.map(p => p.abs), 0.05) * 1.15;

  const tx = c => pad.left + (c / maxConc) * plotW;
  const ty = a => H - pad.bottom - (a / maxAbs) * plotH;

  // Axes
  ctx.strokeStyle = '#0f2e0f';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad.left, pad.top);
  ctx.lineTo(pad.left, H - pad.bottom);
  ctx.lineTo(W - pad.right, H - pad.bottom);
  ctx.stroke();

  // Axis tick labels
  ctx.fillStyle = '#1c6634';
  ctx.font = '7px monospace';
  ctx.textAlign = 'center';
  [0, 100, 200].forEach(c => {
    ctx.fillText(c, tx(c), H - 5);
  });
  ctx.textAlign = 'right';
  [0, maxAbs / 2].forEach(a => {
    ctx.fillText(a.toFixed(2), pad.left - 2, ty(a) + 3);
  });

  // Trend line
  const n = points.length;
  let sX = 0, sY = 0, sXY = 0, sXX = 0;
  points.forEach(p => { sX += p.conc; sY += p.abs; sXY += p.conc * p.abs; sXX += p.conc * p.conc; });
  const slope = (n * sXY - sX * sY) / (n * sXX - sX * sX);
  const inter = (sY - slope * sX) / n;

  ctx.strokeStyle = '#1a5a1a';
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 2]);
  ctx.beginPath();
  ctx.moveTo(tx(0), ty(inter));
  ctx.lineTo(tx(200), ty(slope * 200 + inter));
  ctx.stroke();
  ctx.setLineDash([]);

  // Points
  points.forEach(p => {
    ctx.fillStyle = r2 >= 0.995 ? '#33ff66' : '#ff5555';
    ctx.beginPath();
    ctx.arc(tx(p.conc), ty(p.abs), 2.5, 0, Math.PI * 2);
    ctx.fill();
  });

  // R² label on chart
  ctx.fillStyle = r2 >= 0.995 ? '#22aa44' : '#cc3333';
  ctx.font = 'bold 7px monospace';
  ctx.textAlign = 'left';
  ctx.fillText(`R²=${r2.toFixed(4)}`, pad.left + 2, pad.top + 8);
}

/* ═══════════════════════════════════════════════════════════════════
   CALIBRATION CURVE → SVG (for print report)
   ═══════════════════════════════════════════════════════════════════ */
function curveToReportSVG(curve, unitLabel) {
  const W = 230, H = 170;
  const pad = { top: 12, right: 12, bottom: 32, left: 40 };
  const pW = W - pad.left - pad.right;
  const pH = H - pad.top - pad.bottom;
  const pts = curve.points;

  const maxC = Math.max(...pts.map(p => p.conc));
  const maxA = Math.max(...pts.map(p => p.abs), 0.001) * 1.15;

  const tx = c => pad.left + (c / maxC) * pW;
  const ty = a => H - pad.bottom - (a / maxA) * pH;

  // Linear regression for trend line
  const n = pts.length;
  const xs = pts.map(p => p.conc), ys = pts.map(p => p.abs);
  const xb = xs.reduce((a, b) => a + b, 0) / n;
  const yb = ys.reduce((a, b) => a + b, 0) / n;
  const ssxy = xs.reduce((s, x, i) => s + (x - xb) * (ys[i] - yb), 0);
  const ssxx = xs.reduce((s, x) => s + (x - xb) ** 2, 0);
  const slope = ssxx ? ssxy / ssxx : 0;
  const intercept = yb - slope * xb;
  const lx1 = tx(0), ly1 = ty(intercept);
  const lx2 = tx(maxC), ly2 = ty(slope * maxC + intercept);

  // Y-axis ticks (4 steps)
  const yStep = maxA / 4;
  const yTicks = Array.from({ length: 5 }, (_, i) => {
    const a = yStep * i;
    const y = ty(a).toFixed(1);
    return `<line x1="${pad.left - 4}" y1="${y}" x2="${pad.left}" y2="${y}" stroke="#888"/>
            <text x="${pad.left - 6}" y="${y}" text-anchor="end" dominant-baseline="middle" font-size="7" fill="#555">${a.toFixed(2)}</text>`;
  }).join('');

  // X-axis ticks
  const xTickVals = [0, 50, 100, 150, 200].filter(v => v <= maxC);
  const xTicks = xTickVals.map(c => {
    const x = tx(c).toFixed(1);
    const yb2 = (H - pad.bottom).toFixed(1);
    return `<line x1="${x}" y1="${yb2}" x2="${x}" y2="${parseFloat(yb2) + 4}" stroke="#888"/>
            <text x="${x}" y="${parseFloat(yb2) + 12}" text-anchor="middle" font-size="7" fill="#555">${c}</text>`;
  }).join('');

  const dotColor = curve.isBad ? '#cc3333' : '#1a7a1a';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"
        style="border:1pt solid #ccc;border-radius:3pt;background:#fafafa;font-family:sans-serif">
    <!-- grid lines -->
    ${Array.from({ length: 5 }, (_, i) => {
      const y = ty(yStep * i).toFixed(1);
      return `<line x1="${pad.left}" y1="${y}" x2="${W - pad.right}" y2="${y}" stroke="#e0e0e0"/>`;
    }).join('')}
    <!-- axes -->
    <line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${H - pad.bottom}" stroke="#444" stroke-width="1.2"/>
    <line x1="${pad.left}" y1="${H - pad.bottom}" x2="${W - pad.right}" y2="${H - pad.bottom}" stroke="#444" stroke-width="1.2"/>
    ${yTicks}
    ${xTicks}
    <!-- axis labels -->
    <text x="${W / 2}" y="${H - 2}" text-anchor="middle" font-size="8" fill="#333">Concentração (${unitLabel})</text>
    <text transform="rotate(-90,10,${H / 2})" x="0" y="${H / 2}" text-anchor="middle" font-size="8" fill="#333">Absorbância</text>
    <!-- regression line -->
    <line x1="${lx1.toFixed(1)}" y1="${ly1.toFixed(1)}" x2="${lx2.toFixed(1)}" y2="${ly2.toFixed(1)}"
          stroke="#1a6ec4" stroke-width="1.4" stroke-dasharray="none"/>
    <!-- data points -->
    ${pts.map(p => `<circle cx="${tx(p.conc).toFixed(1)}" cy="${ty(p.abs).toFixed(1)}" r="3.5"
          fill="${dotColor}" stroke="#fff" stroke-width="0.8"/>`).join('')}
    <!-- r² annotation -->
    <text x="${W - pad.right - 2}" y="${pad.top + 10}" text-anchor="end" font-size="8" fill="#333">r² = ${curve.r2.toFixed(4)}</text>
  </svg>`;
}

/* ═══════════════════════════════════════════════════════════════════
   PRINT REPORT
   ═══════════════════════════════════════════════════════════════════ */
function printReport() {
  const now      = new Date();
  const dateStr  = now.toLocaleDateString('pt-BR');
  const timeStr  = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const assay    = state.mode === 'glucose' ? 'Glicose (GOD-PAP)' : state.analyteName;
  const unit     = getUnit();
  const stdConc  = getStdConc();
  const lambda   = state.lambda;

  // Triplicate data
  const tripl       = state.triplicateReadings;
  const triHasData  = tripl.length > 0;
  const mean        = state.triplicateMean;
  const sd          = state.triplicateSD;
  const cv          = state.triplicateCV;
  const fator       = state.fator;
  const failed      = state.triplicateFailedAttempts; // array of prior failed attempts

  // Selected curve
  const selCurve = state.generatedCurves.find(c => c.label === state.selectedCurveLabel);

  /* ── Failed attempts block ── */
  const failedBlock = failed.length ? `
    <h2>Tentativas Reprovadas (CV &gt; ${CV_THRESHOLD}%)</h2>
    ${failed.map(f => `
      <div style="background:#fff8f8;border:1pt solid #cc6666;padding:8pt 10pt;margin:4pt 0;border-radius:2pt">
        <strong>Tentativa ${f.attempt}</strong> &nbsp;·&nbsp;
        CV = <strong style="color:#cc0000">${f.cv.toFixed(2)}%</strong>
        &nbsp;·&nbsp; Média = ${f.mean ? f.mean.toFixed(4) : '—'} Abs
        &mdash; <em>Reprovada, leitura repetida</em>
        <table style="margin-top:6pt"><thead><tr><th>Leitura</th><th>Abs</th><th>%T</th></tr></thead>
        <tbody>
          ${f.readings.map(r => `<tr>
            <td>${r.label}</td>
            <td style="font-family:monospace;text-align:right">${r.abs.toFixed(4)}</td>
            <td style="font-family:monospace;text-align:right">${r.pctT.toFixed(1)}</td>
          </tr>`).join('')}
        </tbody></table>
      </div>`).join('')}` : '';

  /* ── CV alert for accepted triplicata ── */
  const cvAlertBlock = (triHasData && cv !== null && cv > 0.5 && cv <= CV_THRESHOLD) ? `
    <div style="background:#fffbf0;border:1pt solid #cc9900;padding:6pt 10pt;margin:4pt 0;font-size:10pt">
      <strong>⚠ Atenção:</strong> CV = ${cv.toFixed(2)}% está no limite do critério (≤ ${CV_THRESHOLD}%).
      Recomenda-se monitorar a precisão analítica desta corrida.
    </div>` : '';

  /* ── Triplicate rows HTML ── */
  const triplRows = triHasData
    ? tripl.map(r => `
        <tr>
          <td>${r.label}</td>
          <td style="text-align:right;font-family:monospace">${r.abs.toFixed(4)}</td>
          <td style="text-align:right;font-family:monospace">${r.pctT.toFixed(1)}</td>
          <td style="text-align:center">${r.included ? '✓ Incluída' : '✗ Rejeitada'}</td>
        </tr>`).join('')
    : '<tr><td colspan="4" style="text-align:center;color:#999">Triplicata não realizada.</td></tr>';

  /* ── Calc block ── */
  let calcBlock = 'Triplicata não aceita.';
  if (triHasData && mean !== null) {
    const included = tripl.filter(r => r.included);
    const labels   = included.map(r => r.label).join(', ');
    const absVals  = included.map(r => r.abs.toFixed(4));
    const expr     = included.length === 1
      ? absVals[0]
      : `(${absVals.join(' + ')}) / ${included.length}`;
    const cvStatus = cv <= 0.5 ? 'Excelente' : cv <= CV_THRESHOLD ? 'Aprovado — no limite' : 'Reprovado';

    calcBlock = `
      Incluídas: ${labels}<br>
      Média = ${expr} = ${mean.toFixed(4)} Abs<br>
      ${included.length > 1 ? `DP = ${sd.toFixed(5)} &nbsp;&nbsp; CV = <strong>${cv.toFixed(2)}%</strong> — ${cvStatus}<br>` : ''}
      Critério de aceitação: CV ≤ ${CV_THRESHOLD}%<br>
      Fator = ${stdConc} / ${mean.toFixed(4)} = <strong>${fator ? fator.toFixed(2) : '—'} ${unit}/Abs</strong>
    `;
  }

  /* ── Curve table + SVG chart ── */
  let curveBlock = '<p style="color:#999">Nenhuma curva selecionada.</p>';
  if (selCurve) {
    const rows = selCurve.points.map((p, i) => `
      <tr>
        <td>${i === 0 ? 'Branco' : 'P' + i}</td>
        <td style="text-align:right">${p.conc}</td>
        <td style="text-align:right;font-family:monospace">${p.abs.toFixed(4)}</td>
      </tr>`).join('');
    curveBlock = `
      <p><strong>Curva ${selCurve.label}</strong> &nbsp;·&nbsp; r = ${selCurve.r.toFixed(4)} &nbsp;·&nbsp; r² = ${selCurve.r2.toFixed(4)}</p>
      <div style="display:flex;gap:16pt;align-items:flex-start;flex-wrap:wrap">
        <table style="flex:none"><thead><tr><th>Padrão</th><th>Conc. (${unit})</th><th>Abs</th></tr></thead>
        <tbody>${rows}</tbody></table>
        <div style="flex:none">${curveToReportSVG(selCurve, unit)}</div>
      </div>`;
  }

  /* ── Results table ── */
  const resultsBlock = state.results.length
    ? `<table>
        <thead><tr>
          <th>#</th><th>Amostra</th><th>λ (nm)</th><th>Abs</th><th>%T</th>
          <th>Fator</th><th>Conc. (${unit})</th><th>Classificação</th>
        </tr></thead>
        <tbody>
          ${state.results.map(r => {
            const ref = classifyResult(r);
            return `<tr>
              <td style="text-align:right">${r.n}</td>
              <td>${r.name}</td>
              <td style="text-align:right">${r.lambda}</td>
              <td style="text-align:right;font-family:monospace">${r.abs.toFixed(4)}</td>
              <td style="text-align:right;font-family:monospace">${r.pctT.toFixed(1)}</td>
              <td style="text-align:right;font-family:monospace">${r.fator.toFixed(2)}</td>
              <td style="text-align:right;font-family:monospace">${r.conc.toFixed(2)}</td>
              <td>${ref ? ref.label : '—'}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`
    : '<p style="color:#999">Nenhuma amostra analisada.</p>';

  /* ── Full report HTML ── */
  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <title>Relatório — ${assay} — ${dateStr}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Times New Roman', serif;
      font-size: 11pt;
      color: #111;
      padding: 2cm;
      max-width: 21cm;
      margin: 0 auto;
    }
    h1 { font-size: 14pt; text-align: center; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 4pt; }
    h2 { font-size: 11pt; text-transform: uppercase; letter-spacing: 0.5px; margin: 16pt 0 6pt; border-bottom: 1px solid #ccc; padding-bottom: 3pt; }
    .header-block { text-align: center; margin-bottom: 16pt; border-bottom: 2px solid #222; padding-bottom: 12pt; }
    .header-block p { font-size: 9pt; color: #555; margin-top: 3pt; }
    .meta-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4pt 16pt; margin-bottom: 4pt; }
    .meta-row { display: flex; gap: 6pt; font-size: 10pt; }
    .meta-key { font-weight: bold; min-width: 110pt; }
    table { width: 100%; border-collapse: collapse; margin: 6pt 0; font-size: 10pt; }
    th { background: #eee; font-weight: bold; text-align: left; padding: 4pt 6pt; border: 1pt solid #bbb; }
    td { padding: 3pt 6pt; border: 1pt solid #ccc; }
    .calc-box { background: #f8f8f8; border: 1pt solid #ccc; padding: 8pt; font-family: monospace; font-size: 10pt; line-height: 1.8; }
    .ref-normal { color: #228B22; font-weight: bold; }
    .ref-hypo   { color: #cc4400; font-weight: bold; }
    .ref-pre    { color: #998800; font-weight: bold; }
    .ref-diab   { color: #cc0000; font-weight: bold; }
    .footer { margin-top: 32pt; border-top: 1pt solid #ccc; padding-top: 12pt; display: grid; grid-template-columns: 1fr 1fr; gap: 20pt; }
    .sig-line { border-bottom: 1pt solid #333; height: 32pt; margin-bottom: 4pt; }
    .sig-label { font-size: 9pt; text-align: center; color: #555; }
    @media print { body { padding: 1cm; } }
  </style>
</head>
<body>
  <div class="header-block">
    <h1>Relatório de Análise Bioquímica</h1>
    <p>Simulador Didático de Espectrofotometria — Bioquímica Clínica</p>
  </div>

  <h2>Dados da Corrida</h2>
  <div class="meta-grid">
    <div class="meta-row"><span class="meta-key">Data:</span><span>${dateStr}</span></div>
    <div class="meta-row"><span class="meta-key">Hora:</span><span>${timeStr}</span></div>
    <div class="meta-row"><span class="meta-key">Ensaio:</span><span>${assay}</span></div>
    <div class="meta-row"><span class="meta-key">Analito:</span><span>${state.mode === 'glucose' ? 'Glicose' : state.analyteName}</span></div>
    <div class="meta-row"><span class="meta-key">λ (nm):</span><span>${lambda} nm</span></div>
    <div class="meta-row"><span class="meta-key">Padrão:</span><span>${stdConc} ${unit}</span></div>
    <div class="meta-row"><span class="meta-key">Fator calc.:</span><span>${fator ? fator.toFixed(2) + ' ' + unit + '/Abs' : 'Não calculado'}</span></div>
    <div class="meta-row"><span class="meta-key">Tentativas:</span><span>${state.triplicateAttempt} (${failed.length} reprovada${failed.length !== 1 ? 's' : ''})</span></div>
  <div class="meta-row"><span class="meta-key">Amostras:</span><span>${state.results.length}</span></div>
  </div>

  ${failedBlock}

  <h2>Triplicata do Padrão Aceita — Tentativa ${state.triplicateAttempt} (${stdConc} ${unit})</h2>
  <table>
    <thead><tr><th>Leitura</th><th>Abs</th><th>%T</th><th>Status</th></tr></thead>
    <tbody>${triplRows}</tbody>
  </table>
  ${cvAlertBlock}

  <h2>Cálculo do Fator de Calibração</h2>
  <div class="calc-box">${calcBlock}</div>

  <h2>Curva de Calibração</h2>
  ${curveBlock}

  <h2>Resultados das Amostras</h2>
  <p style="font-size:9pt;color:#777;margin-bottom:6pt">
    Referência (glicemia em jejum): Normal 70–99 mg/dL · Hipoglicemia &lt;70 · Pré-diabetes 100–125 · Diabetes ≥126 mg/dL
  </p>
  ${resultsBlock}

  <div class="footer">
    <div>
      <div class="sig-line"></div>
      <div class="sig-label">Estudante / Analista</div>
    </div>
    <div>
      <div class="sig-line"></div>
      <div class="sig-label">Docente Responsável</div>
    </div>
  </div>
</body>
</html>`;

  const win = window.open('', '_blank', 'width=900,height=700');
  win.document.write(html);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 600);
}

/* ═══════════════════════════════════════════════════════════════════
   HELP MODAL
   ═══════════════════════════════════════════════════════════════════ */
function openHelp()  { document.getElementById('helpModal').classList.remove('hidden'); }
function closeHelp() { document.getElementById('helpModal').classList.add('hidden'); }

function handleModalClick(e) {
  if (e.target === e.currentTarget) closeHelp();
}

/* ═══════════════════════════════════════════════════════════════════
   DIAGRAM TOGGLE
   ═══════════════════════════════════════════════════════════════════ */
let diagramVisible = true;
function toggleDiagram() {
  diagramVisible = !diagramVisible;
  const container = document.getElementById('diagramContainer');
  const label     = document.getElementById('diagramToggleLabel');
  container.classList.toggle('hidden', !diagramVisible);
  label.textContent = (diagramVisible ? '▼' : '▶') + ' Diagrama do Equipamento';
}

/* ═══════════════════════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════════════════════ */
function getEpsilon() { return EPSILON_MAP[state.lambda] || 0.00300; }
function getStdConc() { return state.mode === 'glucose' ? 100 : state.stdConc; }
function getUnit()    { return state.mode === 'glucose' ? 'mg/dL' : state.unit; }
function shuffled(arr) {
  return [...arr].sort(() => Math.random() - 0.5);
}
