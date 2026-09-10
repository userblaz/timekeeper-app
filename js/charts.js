// SVG chart builders used for the offset/drift history charts.

function buildLineChart(items, opts){
  if(items.length === 0) return `<div class="empty-note">${opts.emptyMsg}</div>`;
  const pxPerPoint = 46 * chartZoom;
  const h = 160, padL = 34, padR = 16, padT = 10, padB = 18;
  const plotW = Math.max(240, (items.length - 1) * pxPerPoint);
  const w = padL + padR + plotW;
  const values = items.map(it => it.value);
  let min = Math.min(...values, 0);
  let max = Math.max(...values, 0);
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
    return `<text x="${xAt(i).toFixed(1)}" y="${h-6}" text-anchor="middle" font-size="9" font-family="'Inter',sans-serif" fill="#A1A1AA">${formatShortDate(it.date)}</text>`;
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

  const svg = `<svg class="chart" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    ${gridlines}
    <line x1="${padL}" y1="${zeroY.toFixed(1)}" x2="${w-padR}" y2="${zeroY.toFixed(1)}" stroke="rgba(255,255,255,0.18)" stroke-width="1" stroke-dasharray="3,3" />
    <path d="${path}" fill="none" stroke="${opts.lineColor}" stroke-width="2" />
    ${dotsSvg}
    ${xLabelsSvg}
  </svg>`;

  const yAxisTicksHtml = ticks.map(t => {
    const y = yAt(t);
    return `<div class="yaxis-tick" style="top:${y.toFixed(1)}px">${opts.formatTick(t)}</div>`;
  }).join('');
  const yAxisHtml = `<div class="chart-yaxis" style="width:${padL}px;height:${h}px">${yAxisTicksHtml}</div>`;

  let tooltipHtml = '';
  if(selIdx !== null && items[selIdx]){
    const it = items[selIdx];
    tooltipHtml = `<span class="chart-tooltip">${formatShortDate(it.date)} · ${opts.formatTooltip(it.value)}</span>`;
  }

  const dateLabel = items.length > 1
    ? `${formatShortDate(items[0].date)} – ${formatShortDate(items[items.length-1].date)}`
    : formatShortDate(items[0].date);
  const meta = `<span class="chart-meta">${dateLabel} · ${opts.formatTick(min)} to ${opts.formatTick(max)}</span>`;
  const bottomRowHtml = `<div class="chart-bottom-row">${tooltipHtml}${meta}</div>`;
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
    formatTick: v => `${Math.round(v)}s`,
    formatTooltip: v => `${v>0?'+':''}${Math.round(v)}s`
  });
}

function buildChart(ratedReadings, selectedIndex){
  const items = ratedReadings.map(r => ({date: r.date, value: r.rate === null ? 0 : r.rate, isReset: !!r.isReset}));
  return buildLineChart(items, {
    chartKey: 'drift',
    lineColor: '#6B6B8C',
    selectedIndex,
    emptyMsg: 'Log a second reading to see a trend line.',
    formatTick: v => `${v.toFixed(1)} s/day`,
    formatTooltip: v => `${v>0?'+':''}${v.toFixed(1)} s/day`
  });
}

