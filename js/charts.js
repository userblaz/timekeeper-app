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

function buildLineChart(items, opts){
  if(items.length === 0) return `<div class="empty-note">${opts.emptyMsg}</div>`;
  const pxPerPoint = 46 * chartZoom;
  const h = 160, padL = 34, padR = 16, padT = 10, padB = 18;
  // Always fill the container, so a chart with one or two readings still
  // spans the full width instead of stopping short of the zoom buttons.
  const minPlotW = Math.max(240, availableChartWidth() - padL - padR);
  const plotW = Math.max(minPlotW, (items.length - 1) * pxPerPoint);
  const w = padL + padR + plotW;
  const values = items.map(it => it.value);
  // What was actually recorded, reported in the summary line.
  const dataMin = Math.min(...values);
  const dataMax = Math.max(...values);
  // What the y-axis has to span: the readings, zero, and the factory spec
  // band when there is one — so the band stays on screen. This is wider than
  // the data, which is why the two are tracked separately.
  const accuracyRange = opts.accuracyRange || null;
  const scaleValues = accuracyRange ? values.concat([accuracyRange.min, accuracyRange.max]) : values;
  let min = Math.min(...scaleValues, 0);
  let max = Math.max(...scaleValues, 0);
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
  const gridlines = ticks.map(t => {
    const y = yAt(t);
    return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${w-padR}" y2="${y.toFixed(1)}" stroke="rgba(255,255,255,0.08)" stroke-width="1" />`;
  }).join('');

  const xLabelsSvg = items.map((it,i) => {
    // the first and last labels sit on the plot edges, so centring them would
    // push half the text outside the chart
    const anchor = i === 0 ? 'start' : (i === items.length-1 ? 'end' : 'middle');
    return `<text x="${xAt(i).toFixed(1)}" y="${h-6}" text-anchor="${anchor}" font-size="9" font-family="'Inter',sans-serif" fill="#A1A1AA">${formatShortDate(it.date)}</text>`;
  }).join('');

  const selIdx = opts.selectedIndex;
  const dotsSvg = pts.map((p,i) => {
    const positive = items[i].value >= 0;
    const color = positive ? '#22C55E' : '#F87171';
    const isSel = selIdx === i;
    const isReset = !!items[i].isReset;
    const ring = isSel ? `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="7" fill="none" stroke="${color}" stroke-width="1.5" />` : '';
    const resetMarker = isReset ? `<line x1="${p[0].toFixed(1)}" y1="${padT}" x2="${p[0].toFixed(1)}" y2="${h-padB}" stroke="#9C9AB5" stroke-width="1" stroke-dasharray="2,2" /><text x="${p[0].toFixed(1)}" y="${padT-4}" text-anchor="middle" font-size="8" font-family="'Inter',sans-serif" fill="#9C9AB5">svc</text>` : '';
    const dotColor = isReset ? '#9C9AB5' : color;
    return `<g class="chart-dot" data-chart="${opts.chartKey}" data-idx="${i}">
      ${resetMarker}
      <circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="11" fill="transparent" />
      ${ring}
      <circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${isSel?4.5:3.5}" fill="${dotColor}" />
    </g>`;
  }).join('');

  let accuracyBandSvg = '';
  if(accuracyRange){
    const yTop = yAt(accuracyRange.max);
    const yBottom = yAt(accuracyRange.min);
    accuracyBandSvg = `
      <rect x="${padL}" y="${yTop.toFixed(1)}" width="${plotW}" height="${(yBottom-yTop).toFixed(1)}" fill="rgba(59,130,246,0.08)" />
      <line x1="${padL}" y1="${yTop.toFixed(1)}" x2="${w-padR}" y2="${yTop.toFixed(1)}" stroke="#3B82F6" stroke-width="1" stroke-dasharray="4,3" />
      <line x1="${padL}" y1="${yBottom.toFixed(1)}" x2="${w-padR}" y2="${yBottom.toFixed(1)}" stroke="#3B82F6" stroke-width="1" stroke-dasharray="4,3" />
      <text x="${w-padR-4}" y="${(yTop-4).toFixed(1)}" text-anchor="end" font-size="8.5" font-family="'Inter',sans-serif" fill="#3B82F6">factory spec</text>
    `;
  }

  const svg = `<svg class="chart" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    ${gridlines}
    ${accuracyBandSvg}
    <line x1="${padL}" y1="${zeroY.toFixed(1)}" x2="${w-padR}" y2="${zeroY.toFixed(1)}" stroke="rgba(255,255,255,0.18)" stroke-width="1" stroke-dasharray="3,3" />
    <path d="${path}" fill="none" stroke="${opts.lineColor}" stroke-width="2" />
    ${dotsSvg}
    ${xLabelsSvg}
  </svg>`;

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
  const colorFor = v => v >= 0 ? '#22C55E' : '#F87171';
  const colored = (v, color) => `<b style="color:${color};font-weight:600">${fmtSigned(v)}${opts.unit}</b>`;

  // Left slot: the tapped reading, or the period summary when nothing is tapped.
  let leftHtml = '';
  if(selIdx !== null && items[selIdx]){
    const it = items[selIdx];
    const color = it.isReset ? '#9C9AB5' : colorFor(it.value);
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

function buildOffsetChart(sortedReadings, selectedIndex){
  const items = sortedReadings.map(r => ({date: r.date, value: r.offset, isReset: !!r.isReset}));
  return buildLineChart(items, {
    chartKey: 'offset',
    lineColor: '#6B6B8C',
    selectedIndex,
    emptyMsg: 'Log a reading to see it plotted here.',
    unit: 's',
    decimals: 0
  });
}

// avgRate is the watch's overall drift across the period, so the summary
// matches the figure on the dial rather than re-deriving a slightly
// different one from the plotted intervals.
function buildChart(ratedReadings, selectedIndex, accuracySpec, avgRate){
  const items = ratedReadings.map(r => ({date: r.date, value: r.rate === null ? 0 : r.rate, isReset: !!r.isReset}));
  return buildLineChart(items, {
    chartKey: 'drift',
    lineColor: '#6B6B8C',
    selectedIndex,
    emptyMsg: 'Log a second reading to see a trend line.',
    unit: ' s/day',
    decimals: 1,
    accuracyRange: parseAccuracySpec(accuracySpec),
    summary: (avgRate === null || avgRate === undefined) ? null : avgRate
  });
}