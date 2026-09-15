// SVG chart builders used for the offset/drift history charts.

// Parses a free-text factory accuracy spec like "-4/+6 s/day", "0/+5", or
// "±5 s/day" into a {min, max} range. Returns null if no numbers are found.
function parseAccuracySpec(spec){
  if(!spec) return null;
  const nums = (spec.match(/[-+]?\d+(\.\d+)?/g) || []).map(Number);
  if(nums.length === 0) return null;
  if(nums.length === 1){
    const n = Math.abs(nums[0]);
    return { min: -n, max: n };
  }
  return { min: Math.min(...nums), max: Math.max(...nums) };
}

// How wide the chart can be drawn before it needs to scroll. Measured from a
// chart already on the page when there is one; on the very first render there
// isn't, so fall back to #root minus the chart box's own padding and border.
function availableChartWidth(){
  const existing = document.querySelector('.chart-scroll');
  if(existing && existing.clientWidth) return existing.clientWidth;
  const root = document.getElementById('root');
  if(root && root.clientWidth) return root.clientWidth - 34;
  return 240;
}

// opts.compact renders the exact same plotted line — same point math, same
// green/red dot-by-sign colouring, same dashed zero line — at collection-
// card size instead of detail-page size: no axis, gridlines, date labels,
// zoom/scroll, or accuracy band, since there's no room to read any of those
// at this scale, and no `<div>` wrapper — just the bare `<svg>`, since it
// sits directly inside the card rather than its own chart box.
function buildLineChart(items, opts){
  const compact = !!opts.compact;
  if(items.length === 0) return compact ? '' : `<div class="empty-note">${opts.emptyMsg}</div>`;
  const pxPerPoint = 46 * chartZoom;
  const h = compact ? (opts.compactHeight || 28) : 160;
  const padL = compact ? 2 : 34, padR = compact ? 2 : 16, padT = compact ? 1 : 10, padB = compact ? 1 : 18;
  // Always fill the container, so a chart with one or two readings still
  // spans the full width instead of stopping short of the zoom buttons.
  // Compact skips that entirely — it's drawn at one fixed small width, never
  // scrolled or zoomed.
  const minPlotW = compact ? (opts.compactWidth || 56) : Math.max(240, availableChartWidth() - padL - padR);
  const plotW = compact ? minPlotW : Math.max(minPlotW, (items.length - 1) * pxPerPoint);
  const w = padL + padR + plotW;
  const values = items.map(it => it.value);
  // What was actually recorded, reported in the summary line.
  const dataMin = Math.min(...values);
  const dataMax = Math.max(...values);
  // What the y-axis has to span: the readings, zero, and the factory spec
  // band when there is one — so the band stays on screen. This is wider than
  // the data, which is why the two are tracked separately. Compact skips
  // both the forced zero baseline and the factory-spec band — neither is
  // drawn at that size, and forcing them into the scale anyway just left
  // dead space above/below the actual line whenever the data didn't
  // naturally reach that far.
  const accuracyRange = opts.accuracyRange || null;
  const scaleValues = (accuracyRange && !compact) ? values.concat([accuracyRange.min, accuracyRange.max]) : values;
  let min = compact ? Math.min(...scaleValues) : Math.min(...scaleValues, 0);
  let max = compact ? Math.max(...scaleValues) : Math.max(...scaleValues, 0);
  if(min === max){ min -= 1; max += 1; }
  const range = max - min;
  const plotH = h - padT - padB;
  const stepX = items.length > 1 ? plotW / (items.length - 1) : 0;
  const xAt = i => padL + i * stepX;
  const yAt = v => padT + (1 - (v - min) / range) * plotH;
  const zeroY = yAt(0);
  const pts = items.map((it,i) => [xAt(i), yAt(it.value)]);
  const path = pts.map((p,i)=> (i===0?'M':'L') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');

  const ticks = [max, min + range*0.75, (max+min)/2, min + range*0.25, min];
  const gridlines = compact ? '' : ticks.map(t => {
    const y = yAt(t);
    return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${w-padR}" y2="${y.toFixed(1)}" stroke="rgba(255,255,255,0.08)" stroke-width="1" />`;
  }).join('');

  const xLabelsSvg = compact ? '' : items.map((it,i) => {
    // the first and last labels sit on the plot edges, so centring them would
    // push half the text outside the chart
    const anchor = i === 0 ? 'start' : (i === items.length-1 ? 'end' : 'middle');
    return `<text x="${xAt(i).toFixed(1)}" y="${h-6}" text-anchor="${anchor}" font-size="9" font-family="'Inter',sans-serif" fill="var(--grey)">${formatShortDate(it.date)}</text>`;
  }).join('');

  const selIdx = opts.selectedIndex;
  const dotsSvg = pts.map((p,i) => {
    const positive = items[i].value >= 0;
    const color = positive ? 'var(--good)' : 'var(--bad)';
    const isSel = selIdx === i;
    const isReset = !!items[i].isReset;
    const ring = (!compact && isSel) ? `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="7" fill="none" stroke="${color}" stroke-width="1.5" />` : '';
    const resetMarker = (!compact && isReset) ? `<line x1="${p[0].toFixed(1)}" y1="${padT}" x2="${p[0].toFixed(1)}" y2="${h-padB}" stroke="var(--grey)" stroke-width="1" stroke-dasharray="2,2" /><text x="${p[0].toFixed(1)}" y="${padT-4}" text-anchor="middle" font-size="8" font-family="'Inter',sans-serif" fill="var(--grey)">svc</text>` : '';
    const dotColor = isReset ? 'var(--grey)' : color;
    const hitCircle = compact ? '' : `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="11" fill="transparent" />`;
    return `<g class="chart-dot" data-chart="${opts.chartKey}" data-idx="${i}">
      ${resetMarker}
      ${hitCircle}
      ${ring}
      <circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${compact ? 2 : (isSel?4.5:3.5)}" fill="${dotColor}" />
    </g>`;
  }).join('');

  let accuracyBandSvg = '';
  if(accuracyRange && !compact){
    const yTop = yAt(accuracyRange.max);
    const yBottom = yAt(accuracyRange.min);
    accuracyBandSvg = `
      <rect x="${padL}" y="${yTop.toFixed(1)}" width="${plotW}" height="${(yBottom-yTop).toFixed(1)}" fill="rgba(59,130,246,0.08)" />
      <line x1="${padL}" y1="${yTop.toFixed(1)}" x2="${w-padR}" y2="${yTop.toFixed(1)}" stroke="var(--accent)" stroke-width="1" stroke-dasharray="4,3" />
      <line x1="${padL}" y1="${yBottom.toFixed(1)}" x2="${w-padR}" y2="${yBottom.toFixed(1)}" stroke="var(--accent)" stroke-width="1" stroke-dasharray="4,3" />
      <text x="${w-padR-4}" y="${(yTop-4).toFixed(1)}" text-anchor="end" font-size="8.5" font-family="'Inter',sans-serif" fill="var(--accent)">factory spec</text>
    `;
  }

  const svg = `<svg class="chart${compact ? ' chart-compact' : ''}" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    ${gridlines}
    ${accuracyBandSvg}
    <line x1="${padL}" y1="${zeroY.toFixed(1)}" x2="${w-padR}" y2="${zeroY.toFixed(1)}" stroke="rgba(255,255,255,0.18)" stroke-width="1" stroke-dasharray="3,3" />
    <path d="${path}" fill="none" stroke="${opts.lineColor}" stroke-width="2" />
    ${dotsSvg}
    ${xLabelsSvg}
  </svg>`;

  if(compact) return svg;

  // Gain a decimal place when the range is too narrow to distinguish the
  // gridlines otherwise — five labels all reading "0" or "-1" is useless.
  const decimals = range < 4 ? Math.max(1, opts.decimals) : opts.decimals;
  const fmtNum = v => v.toFixed(decimals);
  const fmtSigned = v => `${v > 0 ? '+' : ''}${v.toFixed(decimals)}`;

  // Axis labels carry no unit — the chart header already names it, and
  // repeating "s/day" on every gridline wrapped each one onto two lines.
  const yAxisTicksHtml = ticks.map(t => {
    const y = yAt(t);
    return `<div class="yaxis-tick" style="top:${y.toFixed(1)}px">${fmtNum(t)}</div>`;
  }).join('');
  const yAxisHtml = `<div class="chart-yaxis" style="width:${padL}px;height:${h}px">${yAxisTicksHtml}</div>`;

  // Colour the reading and its unit as one figure, leaving only the date in
  // the label's own colour — and use the same sign rule the dots use, so a
  // tapped reading reads out in the colour of the dot you just tapped.
  const colorFor = v => v >= 0 ? 'var(--good)' : 'var(--bad)';
  const colored = (v, color) => `<b style="color:${color};font-weight:600">${fmtSigned(v)}${opts.unit}</b>`;

  // Left slot: the tapped reading, or the period summary when nothing is tapped.
  let leftHtml = '';
  if(selIdx !== null && items[selIdx]){
    const it = items[selIdx];
    const color = it.isReset ? 'var(--grey)' : colorFor(it.value);
    leftHtml = `<span class="chart-tooltip">${formatShortDate(it.date)} · ${colored(it.value, color)}</span>`;
  } else if(opts.summary !== null && opts.summary !== undefined){
    leftHtml = `<span class="chart-tooltip">avg ${colored(opts.summary, colorFor(opts.summary))}</span>`;
  }

  const dateLabel = items.length > 1
    ? `${formatShortDate(items[0].date)} – ${formatShortDate(items[items.length-1].date)}`
    : formatShortDate(items[0].date);
  const meta = `<span class="chart-meta">${dateLabel} · ${fmtNum(dataMin)} to ${fmtNum(dataMax)}${opts.unit}</span>`;
  const bottomRowHtml = `<div class="chart-bottom-row">${leftHtml}${meta}</div>`;
  const containerHtml = `<div class="chart-container">
    ${yAxisHtml}
    <div class="chart-scroll" id="${opts.chartKey}ChartScroll">${svg}</div>
  </div>
  <div class="custom-scrollbar-track" id="${opts.chartKey}ChartScrollTrack"><div class="custom-scrollbar-thumb horizontal" id="${opts.chartKey}ChartScrollThumb"></div></div>`;
  return containerHtml + bottomRowHtml;
}

// compactOpts, when passed, is forwarded straight into buildLineChart's own
// opts (see its `compact` handling above) — the collection card's use of
// this function, not a difference in how the chart itself is built.
function buildOffsetChart(sortedReadings, selectedIndex, compactOpts){
  const items = sortedReadings.map(r => ({date: r.date, value: r.offset, isReset: !!r.isReset}));
  return buildLineChart(items, {
    chartKey: 'offset',
    lineColor: 'var(--chart-line)',
    selectedIndex,
    emptyMsg: 'Log a reading to see it plotted here.',
    unit: 's',
    decimals: 0,
    ...compactOpts
  });
}

// avgRate is the watch's overall drift across the period, so the summary
// matches the figure on the dial rather than re-deriving a slightly
// different one from the plotted intervals. compactOpts: see buildOffsetChart.
function buildChart(ratedReadings, selectedIndex, accuracySpec, avgRate, compactOpts){
  const items = ratedReadings.map(r => ({date: r.date, value: r.rate === null ? 0 : r.rate, isReset: !!r.isReset}));
  return buildLineChart(items, {
    chartKey: 'drift',
    lineColor: 'var(--chart-line)',
    selectedIndex,
    emptyMsg: 'Log a second reading to see a trend line.',
    unit: ' s/day',
    decimals: 1,
    accuracyRange: parseAccuracySpec(accuracySpec),
    summary: (avgRate === null || avgRate === undefined) ? null : avgRate,
    ...compactOpts
  });
}

// The collection list card's preview: the same two charts the detail page
// shows in full (buildOffsetChart above buildChart), stacked the same way,
// just at compact size — not a separate simplified chart style. Nothing is
// drawn until there are at least two readings — a single point has no trend
// to show, and would just be a dot sitting off-center.
function buildCardCharts(w){
  if(!w.readings || w.readings.length < 2) return '';
  const rated = computeReadingRates(w);
  const compactOpts = {compact: true, compactWidth: 56, compactHeight: 26};
  return `<div class="mini-chart-stack">
    <div class="mini-chart-row">
      <span class="mini-chart-label">offset</span>
      ${buildOffsetChart(rated, null, compactOpts)}
    </div>
    <div class="mini-chart-row">
      <span class="mini-chart-label">drift</span>
      ${buildChart(rated, null, w.accuracySpec, null, compactOpts)}
    </div>
  </div>`;
}