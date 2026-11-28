import { docsUrl, LEVELS, STATION_MAP, t, UI } from '../i18n.js';
import type { AuditReport, AutonomyLevel, CheckStatus, RenderOptions } from '../types.js';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&#39;');
}

function statusClass(status: CheckStatus): string {
  switch (status) {
    case 'pass':
      return 'badge-ok';
    case 'warn':
      return 'badge-warn';
    case 'fail':
      return 'badge-err';
    case 'info':
      return 'badge-info';
  }
}

function statusLabel(status: CheckStatus, lang: 'en' | 'pl'): string {
  switch (status) {
    case 'pass':
      return t(UI.pass, lang);
    case 'warn':
      return t(UI.warn, lang);
    case 'fail':
      return t(UI.fail, lang);
    case 'info':
      return t(UI.info, lang);
  }
}

function renderLadderRuler(current: AutonomyLevel, raw: AutonomyLevel, lang: 'en' | 'pl'): string {
  const rungs: Array<AutonomyLevel> = [0, 1, 2, 3, 4, 5];
  return `<div class="ladder-grid" role="list" aria-label="${escapeHtml(t(UI.autonomyLevel, lang))}">
${rungs
  .map((lvl) => {
    const meta = LEVELS[lvl];
    const isCurrent = lvl === current;
    const isReached = lvl <= current;
    const isCappedRaw = lvl === raw && raw !== current;
    const cls = [
      'ladder-cell',
      isCurrent ? 'is-current' : '',
      isReached && !isCurrent ? 'is-reached' : '',
      isCappedRaw ? 'is-capped-raw' : '',
    ]
      .filter(Boolean)
      .join(' ');
    return `  <div class="${cls}" role="listitem">
    <div class="mono ladder-num">L${lvl}</div>
    <div class="ladder-name">${escapeHtml(t(meta.shortName, lang))}</div>
  </div>`;
  })
  .join('\n')}
</div>`;
}

export function renderHtml(report: AuditReport, options: RenderOptions = {}): string {
  const lang = options.lang ?? report.lang;
  const noPromo = Boolean(options.noPromo) || Boolean(options.ci);
  const levelMeta = LEVELS[report.level];

  const stackChips = [
    ...report.stack.languages,
    ...report.stack.frameworks,
    ...report.stack.packageManagers.map((pm) => `pm:${pm}`),
    report.stack.monorepo ? 'monorepo' : '',
  ]
    .filter(Boolean)
    .map((item) => `<span class="chip">${escapeHtml(item)}</span>`)
    .join('');

  const capsHtml =
    report.levelCaps.length > 0
      ? `<section class="section">
    <div class="eyebrow">${escapeHtml(t(UI.levelCapsHeading, lang))}</div>
    <div class="cap-box">
      ${report.levelCaps
        .map(
          (cap) => `<div class="cap-row">
        <span class="badge badge-warn">CAP → L${cap.cappedTo}</span>
        <div>
          <p class="cap-text">${escapeHtml(t(cap.reason, lang))}</p>
          <div class="mono meta-line">${escapeHtml(cap.triggeredBy.join(' · '))}</div>
        </div>
      </div>`,
        )
        .join('\n')}
    </div>
  </section>`
      : '';

  const stationsHtml = report.stations
    .map((st) => {
      const meta = STATION_MAP[st.id];
      const barClass = st.score >= 78 ? 'bar-ok' : st.score >= 50 ? 'bar-signal' : 'bar-err';
      return `<div class="station-card">
      <div class="station-head">
        <div>
          <div class="mono eyebrow-sm">0${meta.order} · ${Math.round(st.weight * 100)}%</div>
          <h3 class="station-title">${escapeHtml(t(meta.name, lang))}</h3>
          <p class="station-desc">${escapeHtml(t(meta.decision, lang))}</p>
        </div>
        <div class="mono station-score">${st.score}<span class="score-denom">/100</span></div>
      </div>
      <div class="bar-track"><div class="bar-fill ${barClass}" style="width:${st.score}%"></div></div>
      <div class="mono station-counts">${st.passed} pass · ${st.warned} warn · ${st.failed} fail</div>
    </div>`;
    })
    .join('\n');

  const topPrioritiesHtml =
    report.topPriorities.length > 0
      ? `<section class="section">
    <div class="eyebrow">02 / ${escapeHtml(t(UI.topPrioritiesHeading, lang))}</div>
    <div class="priority-list">
      ${report.topPriorities
        .map(
          (c, i) => `<article class="priority-row">
        <div class="mono priority-idx">0${i + 1}</div>
        <div class="priority-body">
          <div class="priority-top">
            <span class="badge ${statusClass(c.status)}">${escapeHtml(statusLabel(c.status, lang))}</span>
            <code class="check-id">${escapeHtml(c.id)}</code>
            <strong class="check-title">${escapeHtml(t(c.title, lang))}</strong>
          </div>
          <p class="detail-line"><span class="mono label">${escapeHtml(t(UI.evidenceLabel, lang))}:</span> ${escapeHtml(c.evidence.join(' · '))}</p>
          <p class="detail-line"><span class="mono label">${escapeHtml(t(UI.fixLabel, lang))}:</span> ${escapeHtml(t(c.fix, lang))}</p>
          <p class="detail-line"><a class="ink-link" href="${escapeHtml(docsUrl(lang, c.docsPath))}" target="_blank" rel="noopener">${escapeHtml(t(UI.docsLabel, lang))}: ${escapeHtml(c.docsPath)}</a></p>
        </div>
      </article>`,
        )
        .join('\n')}
    </div>
  </section>`
      : '';

  const detailsHtml = report.stations
    .map((st) => {
      const meta = STATION_MAP[st.id];
      const rows = st.checks
        .map(
          (c) => `<tr>
          <td><span class="badge ${statusClass(c.status)}">${escapeHtml(statusLabel(c.status, lang))}</span></td>
          <td><code class="check-id">${escapeHtml(c.id)}</code></td>
          <td>
            <div class="cell-title">${escapeHtml(t(c.title, lang))}</div>
            ${c.status === 'fail' || c.status === 'warn' ? `<div class="cell-fix">${escapeHtml(t(c.fix, lang))}</div>` : ''}
          </td>
          <td class="cell-evidence">${c.evidence.map((e) => `<div>${escapeHtml(e)}</div>`).join('')}</td>
        </tr>`,
        )
        .join('\n');
      return `<div class="station-table-wrap">
      <div class="table-head-bar">
        <h3 class="table-station-title"><span class="mono">0${meta.order}</span> ${escapeHtml(t(meta.name, lang))}</h3>
        <span class="mono">${st.score}/100</span>
      </div>
      <table class="audit-table">
        <thead>
          <tr>
            <th style="width:76px">Status</th>
            <th style="width:220px">Check</th>
            <th>Finding &amp; Fix</th>
            <th style="width:34%">${escapeHtml(t(UI.evidenceLabel, lang))}</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
    })
    .join('\n');

  const interviewHtml = report.interview
    ? `<section class="section">
    <div class="eyebrow">${escapeHtml(t(UI.interviewHeading, lang))} · ${report.interview.score}/100 (${escapeHtml(report.interview.role)})</div>
    <table class="audit-table">
      <thead><tr><th style="width:72px">Score</th><th>Question</th><th>Response</th></tr></thead>
      <tbody>
        ${report.interview.answers
          .map(
            (a) => `<tr>
          <td class="mono">${a.score}/2</td>
          <td>${escapeHtml(t(a.question, lang))}</td>
          <td>${escapeHtml(t(a.choiceLabel, lang))}</td>
        </tr>`,
          )
          .join('\n')}
      </tbody>
    </table>
  </section>`
    : '';

  const deepHtml = report.deepReview
    ? `<section class="section">
    <div class="eyebrow">${escapeHtml(t(UI.deepReviewHeading, lang))} · ${escapeHtml(report.deepReview.provider)}</div>
    ${
      report.deepReview.error
        ? `<div class="cap-box"><p>${escapeHtml(report.deepReview.error)}</p></div>`
        : `<p class="lede-sm">${escapeHtml(report.deepReview.summary)}</p>
        <div class="priority-list">
          ${report.deepReview.findings
            .map(
              (f) => `<div class="priority-row">
            <div class="mono priority-idx">${escapeHtml(f.area.toUpperCase())}</div>
            <div class="priority-body">
              <div class="priority-top">
                <span class="badge ${f.severity === 'high' ? 'badge-err' : f.severity === 'medium' ? 'badge-warn' : 'badge-info'}">${escapeHtml(f.severity.toUpperCase())}</span>
                <strong>${escapeHtml(f.title)}</strong>
              </div>
              <p class="detail-line">${escapeHtml(f.detail)}</p>
              <p class="detail-line"><span class="mono label">${escapeHtml(t(UI.fixLabel, lang))}:</span> ${escapeHtml(f.suggestion)}</p>
            </div>
          </div>`,
            )
            .join('\n')}
        </div>`
    }
  </section>`
    : '';

  const nextStepsHtml = !noPromo
    ? `<section class="ink-band">
    <div class="ink-inner">
      <div class="mono eyebrow-inv">${escapeHtml(t(UI.nextStepsHeading, lang))}</div>
      <div class="next-grid">
        <div class="next-card">
          <div class="mono next-label">01 · CLI FIX PROMPT</div>
          <p>${escapeHtml(t(UI.fixPromptHint, lang))}</p>
          <pre class="code-well"><code>npx harness-audit --prompt --out HARNESS-FIX-PROMPT.md</code></pre>
        </div>
        <div class="next-card">
          <div class="mono next-label">02 · ${escapeHtml(t(UI.deepDiveBook, lang).toUpperCase())}</div>
          <h4>${escapeHtml(t(report.recommendations.book.title, lang))}</h4>
          <p>${escapeHtml(t(report.recommendations.book.reason, lang))}</p>
          <a class="signal-btn" href="${escapeHtml(report.recommendations.book.url)}" target="_blank" rel="noopener">${escapeHtml(t(report.recommendations.book.title, lang))} →</a>
        </div>
        ${
          report.recommendations.service.show
            ? `<div class="next-card">
          <div class="mono next-label">03 · ${escapeHtml(t(UI.forTeams, lang).toUpperCase())}</div>
          <h4>${escapeHtml(t(report.recommendations.service.headline, lang))}</h4>
          <p>${escapeHtml(t(report.recommendations.service.body, lang))}</p>
          <a class="inv-link" href="${escapeHtml(report.recommendations.service.url)}" target="_blank" rel="noopener">${escapeHtml(report.recommendations.service.url)} →</a>
        </div>`
            : ''
        }
      </div>
    </div>
  </section>`
    : '';

  return `<!doctype html>
<html lang="${lang}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(t(UI.reportTitle, lang))} — ${escapeHtml(report.repoName)}</title>
  <style>
    /* developerToolkit.ai "Schematic" design system tokens (standalone, zero external requests) */
    :root {
      --paper: #fafaf9;
      --raised: #ffffff;
      --field: #f4f4f2;
      --ink: #17151a;
      --fg2: #57535e;
      --fg3: #726d78;
      --rule: #e6e5e2;
      --rule2: #cfcdc8;
      --signal: #ff4d00;
      --on-signal: #17151a;
      --signal-text: #c2410c;
      --ok: #15803d;
      --ok-soft: #f0f7f2;
      --warn: #8f6b00;
      --warn-soft: #f8f5ea;
      --err: #b4232a;
      --err-soft: #faf0f0;
      --info: #1d4ed8;
      --info-soft: #eef2fd;
      --ink-bg: #0e0d10;
      --d2: #151318;
      --db: #26242c;
      --dfg: #f2f1ef;
      --dfg2: #c3c0c7;
      --font-sans: "Archivo", ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Helvetica Neue", Arial, sans-serif;
      --font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --paper: #0e0d10;
        --raised: #151318;
        --field: #1b1920;
        --ink: #f2f1ef;
        --fg2: #c3c0c7;
        --fg3: #8d8995;
        --rule: #26242c;
        --rule2: #3a3742;
        --signal-text: #ff7a33;
        --on-signal: #0e0d10;
        --ok: #4ade80;
        --ok-soft: #10201a;
        --warn: #e0b64a;
        --warn-soft: #241f10;
        --err: #f2777e;
        --err-soft: #271418;
        --info: #93a8f4;
        --info-soft: #14172a;
        --ink-bg: #151318;
      }
    }
    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--paper);
      color: var(--ink);
      font-family: var(--font-sans);
      font-size: 15px;
      line-height: 1.6;
      -webkit-font-smoothing: antialiased;
    }
    .mono { font-family: var(--font-mono); }
    .wrap { max-width: 1120px; margin: 0 auto; padding: 40px 28px 64px; }
    .topbar {
      display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline;
      gap: 12px; padding-bottom: 18px; border-bottom: 1px solid var(--rule);
    }
    .brand { font-family: var(--font-mono); font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--fg3); }
    .brand-dot { display: inline-block; width: 8px; height: 8px; background: var(--signal); margin-right: 8px; vertical-align: middle; }
    .hero { display: grid; grid-template-columns: 1.4fr 1fr; gap: 24px; padding: 32px 0; border-bottom: 1px solid var(--rule); }
    @media (max-width: 780px) { .hero { grid-template-columns: 1fr; } }
    h1 { margin: 8px 0 12px; font-size: 38px; line-height: 1.1; letter-spacing: -0.025em; font-weight: 700; }
    .lede { margin: 0 0 16px; color: var(--fg2); font-size: 16px; max-width: 58ch; }
    .lede-sm { margin: 0 0 16px; color: var(--fg2); }
    .eyebrow { font-family: var(--font-mono); font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--signal-text); margin-bottom: 12px; }
    .eyebrow-sm { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--fg3); }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
    .chip { font-family: var(--font-mono); font-size: 12px; padding: 2px 8px; border: 1px solid var(--rule2); background: var(--raised); border-radius: 3px; color: var(--fg2); }
    .score-panel {
      background: var(--raised); border: 1px solid var(--rule); border-top: 3px solid var(--signal);
      padding: 20px 24px; display: flex; flex-direction: column; justify-content: space-between; gap: 14px;
    }
    .score-row { display: flex; justify-content: space-between; align-items: baseline; }
    .score-big { font-family: var(--font-mono); font-size: 52px; font-weight: 700; line-height: 1; letter-spacing: -0.03em; }
    .score-denom { font-size: 16px; color: var(--fg3); font-weight: 400; }
    .level-pill { background: var(--signal); color: var(--on-signal); font-family: var(--font-mono); font-weight: 700; font-size: 13px; padding: 4px 10px; border-radius: 2px; display: inline-block; }
    .ladder-grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 6px; margin-top: 8px; }
    @media (max-width: 640px) { .ladder-grid { grid-template-columns: repeat(3, 1fr); } }
    .ladder-cell { border: 1px solid var(--rule); padding: 8px 6px; background: var(--paper); border-radius: 2px; }
    .ladder-cell.is-reached { border-color: var(--rule2); background: var(--field); }
    .ladder-cell.is-current { border-color: var(--signal); background: var(--signal); color: var(--on-signal); }
    .ladder-cell.is-capped-raw { border-style: dashed; border-color: var(--warn); }
    .ladder-num { font-size: 11px; font-weight: 700; }
    .ladder-name { font-size: 11px; line-height: 1.25; margin-top: 2px; }
    .section { padding: 32px 0; border-bottom: 1px solid var(--rule); }
    .stations-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
    @media (max-width: 900px) { .stations-grid { grid-template-columns: repeat(2, 1fr); } }
    @media (max-width: 600px) { .stations-grid { grid-template-columns: 1fr; } }
    .station-card { background: var(--raised); border: 1px solid var(--rule); padding: 18px; border-radius: 3px; }
    .station-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
    .station-title { margin: 4px 0; font-size: 18px; font-weight: 600; }
    .station-desc { margin: 0 0 12px; font-size: 13px; color: var(--fg2); }
    .station-score { font-size: 24px; font-weight: 700; white-space: nowrap; }
    .bar-track { height: 6px; background: var(--field); border: 1px solid var(--rule); overflow: hidden; margin-bottom: 8px; }
    .bar-fill { height: 100%; }
    .bar-ok { background: var(--ok); }
    .bar-signal { background: var(--signal); }
    .bar-err { background: var(--err); }
    .station-counts { font-size: 12px; color: var(--fg3); }
    .cap-box { border: 1px solid var(--warn); background: var(--warn-soft); padding: 16px 18px; border-radius: 3px; display: flex; flex-direction: column; gap: 10px; }
    .cap-row { display: flex; gap: 12px; align-items: flex-start; }
    .cap-text { margin: 0 0 4px; font-weight: 500; }
    .meta-line { font-size: 12px; color: var(--fg3); }
    .badge { font-family: var(--font-mono); font-size: 11px; font-weight: 600; padding: 2px 7px; border-radius: 2px; display: inline-block; letter-spacing: 0.04em; border: 1px solid transparent; }
    .badge-ok { background: var(--ok-soft); color: var(--ok); border-color: var(--ok); }
    .badge-warn { background: var(--warn-soft); color: var(--warn); border-color: var(--warn); }
    .badge-err { background: var(--err-soft); color: var(--err); border-color: var(--err); }
    .badge-info { background: var(--info-soft); color: var(--info); border-color: var(--info); }
    .priority-list { display: flex; flex-direction: column; border-top: 1px solid var(--rule); }
    .priority-row { display: grid; grid-template-columns: 44px 1fr; gap: 14px; padding: 16px 0; border-bottom: 1px solid var(--rule); }
    .priority-idx { font-size: 13px; color: var(--fg3); padding-top: 2px; }
    .priority-top { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 6px; }
    .check-id { font-family: var(--font-mono); font-size: 12px; background: var(--field); padding: 2px 6px; border-radius: 2px; border: 1px solid var(--rule); }
    .detail-line { margin: 4px 0; font-size: 14px; color: var(--fg2); }
    .label { font-size: 12px; color: var(--fg3); text-transform: uppercase; }
    .ink-link { color: var(--ink); text-decoration: none; border-bottom: 1px solid var(--signal); padding-bottom: 1px; }
    .station-table-wrap { margin-bottom: 24px; border: 1px solid var(--rule); background: var(--raised); border-radius: 3px; overflow: hidden; }
    .table-head-bar { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; background: var(--field); border-bottom: 1px solid var(--rule); }
    .table-station-title { margin: 0; font-size: 16px; font-weight: 600; }
    .audit-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .audit-table th, .audit-table td { text-align: left; padding: 10px 14px; border-bottom: 1px solid var(--rule); vertical-align: top; }
    .audit-table th { font-family: var(--font-mono); font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--fg3); background: var(--paper); }
    .audit-table tr:last-child td { border-bottom: none; }
    .cell-title { font-weight: 600; margin-bottom: 3px; }
    .cell-fix { color: var(--fg2); font-size: 12.5px; }
    .cell-evidence { font-family: var(--font-mono); font-size: 12px; color: var(--fg2); word-break: break-word; }
    .ink-band { background: var(--ink-bg); color: var(--dfg); margin-top: 32px; border-radius: 4px; border: 1px solid var(--db); }
    .ink-inner { padding: 28px 28px; }
    .eyebrow-inv { font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: #ff7a33; margin-bottom: 16px; }
    .next-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 20px; }
    .next-card { border: 1px solid var(--db); background: var(--d2); padding: 18px; border-radius: 3px; }
    .next-card h4 { margin: 6px 0 8px; font-size: 16px; color: var(--dfg); }
    .next-card p { margin: 0 0 12px; font-size: 13.5px; color: var(--dfg2); }
    .next-label { font-size: 11px; color: #ff7a33; letter-spacing: 0.06em; }
    .code-well { background: #0e0d10; color: #e9e8ea; padding: 10px 12px; border: 1px solid var(--db); border-radius: 2px; overflow-x: auto; font-family: var(--font-mono); font-size: 12px; margin: 0; }
    .signal-btn { display: inline-block; background: var(--signal); color: #17151a; font-weight: 700; text-decoration: none; padding: 8px 14px; border-radius: 3px; font-size: 13px; }
    .inv-link { color: var(--dfg); text-decoration: none; border-bottom: 1px solid var(--signal); font-size: 13px; }
    footer { padding-top: 24px; font-family: var(--font-mono); font-size: 12px; color: var(--fg3); display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
    @media print {
      body { background: #ffffff; color: #17151a; font-size: 12px; }
      .wrap { padding: 12px; max-width: none; }
      .station-table-wrap, .station-card, .ink-band { break-inside: avoid; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <header class="topbar">
      <div class="brand"><span class="brand-dot"></span>@wondelai/harness-audit v${escapeHtml(report.toolVersion)} · developertoolkit.ai</div>
      <div class="mono meta-line">${escapeHtml(report.auditedAt)}</div>
    </header>

    <section class="hero">
      <div>
        <div class="eyebrow">${escapeHtml(t(UI.subtitle, lang))}</div>
        <h1>${escapeHtml(report.repoName)}</h1>
        <p class="lede">${escapeHtml(t(levelMeta.summary, lang))}</p>
        <div class="chips">${stackChips}</div>
        ${
          report.git.isGitRepo
            ? `<div class="mono meta-line" style="margin-top:12px">git: ${escapeHtml(report.git.branch ?? 'HEAD')} · ${report.git.gitAuthors90d} ${escapeHtml(t(UI.contributors90d, lang))} · ${report.git.commits30d} ${escapeHtml(t(UI.commits30d, lang))}</div>`
            : ''
        }
      </div>
      <aside class="score-panel">
        <div class="score-row">
          <div>
            <div class="mono eyebrow-sm">${escapeHtml(t(UI.overallScore, lang))}</div>
            <div class="score-big">${report.overallScore}<span class="score-denom">/100</span></div>
          </div>
          <div style="text-align:right">
            <span class="level-pill">LEVEL ${report.level} · ${escapeHtml(t(levelMeta.shortName, lang).toUpperCase())}</span>
            <div class="mono meta-line" style="margin-top:6px">${escapeHtml(t(levelMeta.shapiroName, lang))}</div>
          </div>
        </div>
        ${renderLadderRuler(report.level, report.rawLevel, lang)}
      </aside>
    </section>

    ${capsHtml}

    <section class="section">
      <div class="eyebrow">01 / ${escapeHtml(t(UI.stationsHeading, lang))}</div>
      <div class="stations-grid">
        ${stationsHtml}
      </div>
    </section>

    ${topPrioritiesHtml}

    <section class="section">
      <div class="eyebrow">03 / ${escapeHtml(t(UI.allChecksHeading, lang))}</div>
      ${detailsHtml}
    </section>

    ${interviewHtml}
    ${deepHtml}
    ${nextStepsHtml}

    <footer>
      <span>${escapeHtml(t(UI.generatedBy, lang))}</span>
      <span>schema v${escapeHtml(report.schemaVersion)}</span>
    </footer>
  </div>
</body>
</html>
`;
}
