// home-analysis.jsx — Home + Analysis tab screens.

// ============================================================
// HOME — the new main tab
// ============================================================
const Home = ({ dark, tier = 'pro' }) => {
  const hasBrief = true; // toggle for "no new brief" empty state later
  return (
    <Phone dark={dark}>
      <Header
        title="Hi, Brian"
        subtitle="Tuesday, May 12"
        dark={dark}
        actions={<>
          <IconBtn icon="bell" dark={dark} />
          <IconBtn icon="user" dark={dark} />
        </>}
      />

      <div className="fm-content" style={{ paddingBottom: 84 }}>
        {/* Net worth / month spend hero — quiet editorial value */}
        <div className="fm-hero">
          <div className="fm-stat-label">May spending</div>
          <div className="fm-hero-value">$1,847<span className="fm-hero-value-decimal">.20</span></div>
          <div className="fm-hero-meta">
            <span>of $2,700 budget</span>
            <span className="fm-hero-meta-dot" />
            <span style={{ color: 'var(--color-up)', fontWeight: 600 }}>$852.80 left</span>
          </div>
          <div className="fm-stat-bar" style={{ marginTop: 16 }}>
            <span style={{ width: '68%' }} />
          </div>
          <div className="fm-hero-axis">
            <span>May 1</span>
            <span>·</span>
            <span>12 days left</span>
            <span>·</span>
            <span>May 31</span>
          </div>
        </div>

        {/* AI brief card — the deep-link to Chat. Quiet with a small Fina cue. */}
        {hasBrief && (
          <div className="fm-brief-card">
            <div className="fm-brief-head">
              <div className="fm-brief-eyebrow">
                <span className="fm-brief-dot" />
                Fina · Morning brief
              </div>
              <div className="fm-brief-time">Just now</div>
            </div>
            <div className="fm-brief-body">
              <p>
                Yesterday came to <strong>$214.83</strong> across 5 transactions. Two need a category. Netflix bills tomorrow.
              </p>
            </div>
            <div className="fm-brief-foot">
              <span className="fm-brief-meta">2 to sort</span>
              <span className="fm-brief-cta">Open <Icon name="chevRight" size={14} strokeWidth={2} /></span>
            </div>
          </div>
        )}

        {/* Section: This month at a glance */}
        <div className="fm-section-eyebrow" style={{ paddingTop: 12 }}>This month</div>
        <div className="fm-glance-grid">
          <div className="fm-glance-card">
            <div className="fm-glance-label">Spent</div>
            <div className="fm-glance-value">$1,847.20</div>
            <div className="fm-glance-trend down">
              <Icon name="trendUp" size={12} strokeWidth={2} /> 12% vs Apr
            </div>
          </div>
          <div className="fm-glance-card">
            <div className="fm-glance-label">Income</div>
            <div className="fm-glance-value" style={{ color: 'var(--color-up)' }}>+$2,840.00</div>
            <div className="fm-glance-trend">
              <span style={{ color: 'var(--color-muted)' }}>1 deposit · May 10</span>
            </div>
          </div>
        </div>

        {/* Top categories — compact rows */}
        <div className="fm-section-eyebrow" style={{ paddingTop: 20 }}>Top categories</div>
        <div className="fm-cat-list">
          <CatRow icon="cart" name="Groceries" amount="$642.18" pct={62} budget="$1,040" />
          <CatRow icon="utensils" name="Dining" amount="$284.20" pct={94} budget="$300" over />
          <CatRow icon="fuel" name="Transport" amount="$210.50" pct={42} budget="$500" />
          <CatRow icon="film" name="Subscriptions" amount="$67.97" pct={68} budget="$100" />
        </div>

        {/* Recent activity peek */}
        <div className="fm-section-eyebrow" style={{ paddingTop: 24, display: 'flex', justifyContent: 'space-between', paddingRight: 24 }}>
          <span>Recent activity</span>
          <span style={{ color: 'var(--color-primary)', fontWeight: 600 }}>See all →</span>
        </div>
        <div style={{ background: dark ? 'transparent' : 'var(--color-canvas)' }}>
          <TxRow icon="coffee" name="Blue Bottle Coffee" cat="Coffee & dining" amount="−$8.40" time="10:24" />
          <TxRow icon="cart" name="Whole Foods" cat="Groceries" amount="−$23.00" time="08:11" />
          <TxRow icon="cart" name="Costco Wholesale" cat={null} amount="−$87.43" time="Yesterday" pending />
        </div>

        <div style={{ height: 24 }} />
      </div>

      <TabBar active="home" badges={{ tx: 2 }} />
    </Phone>
  );
};

const CatRow = ({ icon, name, amount, pct, budget, over = false }) => (
  <div className="fm-catrow">
    <div className="fm-cat-glyph" style={{ width: 36, height: 36, fontSize: 16 }}>
      <Icon name={icon} size={16} />
    </div>
    <div style={{ flex: 1, minWidth: 0 }}>
      <div className="fm-catrow-top">
        <span className="fm-catrow-name">{name}</span>
        <span className={`fm-catrow-amt${over ? ' over' : ''}`}>{amount}</span>
      </div>
      <div className="fm-catrow-bar">
        <span style={{ width: `${Math.min(pct, 100)}%`, background: over ? 'var(--color-down)' : 'var(--color-primary)' }} />
      </div>
      <div className="fm-catrow-meta">
        <span>{pct}% of {budget}</span>
        {over && <span style={{ color: 'var(--color-down)', fontWeight: 600 }}>Over</span>}
      </div>
    </div>
  </div>
);

// ============================================================
// ANALYSIS — the new tab
// ============================================================
const Analysis = ({ dark }) => (
  <Phone dark={dark}>
    <Header
      title="Analysis"
      dark={dark}
      actions={<IconBtn icon="more" dark={dark} />}
    />
    <div className="fm-content" style={{ paddingBottom: 84 }}>
      {/* Period stepper — month nav + M/Q/Y unit toggle */}
      <div className="fm-period-bar">
        <button className="fm-period-step" aria-label="Previous period">
          <Icon name="chevLeft" size={18} strokeWidth={2.2} />
        </button>
        <button className="fm-period-label">
          <span>May 2025</span>
          <Icon name="chevDown" size={13} strokeWidth={2.4} />
        </button>
        <button className="fm-period-step" aria-label="Next period">
          <Icon name="chevRight" size={18} strokeWidth={2.2} />
        </button>
        <div className="fm-period-mqy">
          <button className="active">M</button>
          <button>Q</button>
          <button>Y</button>
        </div>
      </div>

      {/* Cashflow chart */}
      <div className="fm-analysis-card">
        <div className="fm-analysis-head">
          <div>
            <div className="fm-stat-label">Net cashflow</div>
            <div className="fm-analysis-value">+$992.80</div>
            <div className="fm-hero-meta" style={{ marginTop: 4 }}>
              <span><span style={{ color: 'var(--color-up)' }}>+$2,840.00</span> income</span>
              <span className="fm-hero-meta-dot" />
              <span><span style={{ color: 'var(--color-down)' }}>−$1,847.20</span> spend</span>
            </div>
          </div>
        </div>
        <CashflowChart />
      </div>

      {/* Category breakdown */}
      <div className="fm-section-eyebrow" style={{ paddingTop: 18 }}>Where it went</div>
      <div className="fm-analysis-card">
        <DonutChart
          segments={[
            { label: 'Groceries', value: 642.18, color: '#3b7bff' },
            { label: 'Dining', value: 284.20, color: '#f4b000' },
            { label: 'Transport', value: 210.50, color: '#05b169' },
            { label: 'Subscriptions', value: 67.97, color: '#cf202f' },
            { label: 'Other', value: 642.35, color: '#a8acb3' },
          ]}
        />
      </div>

      {/* Vs last month */}
      <div className="fm-section-eyebrow" style={{ paddingTop: 18 }}>vs April</div>
      <div className="fm-analysis-card">
        <CompareRow name="Groceries" current="$642.18" delta={48.20} pct={8} />
        <CompareRow name="Dining" current="$284.20" delta={92.40} pct={48} over />
        <CompareRow name="Transport" current="$210.50" delta={-42.10} pct={-17} />
        <CompareRow name="Subscriptions" current="$67.97" delta={0} pct={0} flat />
      </div>

      {/* AI insight */}
      <div className="fm-insight-card">
        <div style={{ flex: 1 }}>
          <div className="fm-brief-eyebrow" style={{ marginBottom: 8 }}>
            <span className="fm-brief-dot" />
            Fina · Insight
          </div>
          <div className="fm-insight-title">Dining is trending high</div>
          <div className="fm-insight-body">
            You&apos;ve spent <strong>$92 more on dining</strong> than last month with 19 days left. Want a $50 weekly cap?
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button className="fm-btn primary" style={{ padding: '8px 14px', fontSize: 14 }}>Set cap</button>
            <button className="fm-btn" style={{ padding: '8px 14px', fontSize: 14 }}>Maybe later</button>
          </div>
        </div>
      </div>

      <div style={{ height: 24 }} />
    </div>
    <TabBar active="analysis" />
  </Phone>
);

const CompareRow = ({ name, current, delta, pct, over = false, flat = false }) => (
  <div className="fm-compare-row">
    <div style={{ flex: 1 }}>
      <div style={{ fontWeight: 600 }}>{name}</div>
      <div style={{ font: 'var(--type-caption)', fontFamily: 'var(--font-mono)', color: 'var(--color-muted)', marginTop: 2 }}>
        {current}
      </div>
    </div>
    <div className={`fm-compare-delta${over ? ' over' : flat ? ' flat' : delta < 0 ? ' down' : ''}`}>
      {!flat && (
        <Icon name={delta > 0 ? 'trendUp' : 'trendDown'} size={12} strokeWidth={2} />
      )}
      {flat ? 'no change' : `${pct > 0 ? '+' : ''}${pct}%`}
    </div>
  </div>
);

// ──────────────────────────────────────────────
// Mini SVG cashflow bar chart
// ──────────────────────────────────────────────
const CashflowChart = () => {
  const data = [
    { m: 'Jan', in: 2840, out: 1620 },
    { m: 'Feb', in: 2840, out: 1980 },
    { m: 'Mar', in: 2840, out: 1750 },
    { m: 'Apr', in: 2840, out: 1798 },
    { m: 'May', in: 2840, out: 1847 },
  ];
  const max = 2840;
  const W = 320, H = 160, pad = 18;
  const barW = 12, gap = 6;
  const groupW = barW * 2 + gap;
  const cellW = (W - pad * 2) / data.length;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 160, marginTop: 4 }}>
      {/* zero line */}
      <line x1={pad} y1={H - 30} x2={W - pad} y2={H - 30} stroke="var(--color-hairline)" strokeWidth="1" />
      {data.map((d, i) => {
        const cx = pad + cellW * i + cellW / 2 - groupW / 2;
        const inH = (d.in / max) * (H - 60);
        const outH = (d.out / max) * (H - 60);
        const current = i === data.length - 1;
        return (
          <g key={i}>
            <rect x={cx} y={H - 30 - inH} width={barW} height={inH}
              fill={current ? 'var(--color-up)' : 'rgba(5,177,105,0.4)'} rx="2" />
            <rect x={cx + barW + gap} y={H - 30 - outH} width={barW} height={outH}
              fill={current ? 'var(--color-down)' : 'rgba(207,32,47,0.4)'} rx="2" />
            <text x={cx + groupW / 2} y={H - 12} textAnchor="middle"
              fill={current ? 'var(--color-ink)' : 'var(--color-muted)'}
              fontFamily="var(--font-mono)" fontSize="11"
              fontWeight={current ? 600 : 400}>
              {d.m}
            </text>
          </g>
        );
      })}
    </svg>
  );
};

// ──────────────────────────────────────────────
// Mini SVG donut + legend
// ──────────────────────────────────────────────
const DonutChart = ({ segments }) => {
  const total = segments.reduce((s, x) => s + x.value, 0);
  const cx = 80, cy = 80, r = 60, sw = 18;
  let acc = 0;
  const C = 2 * Math.PI * r;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
      <svg viewBox="0 0 160 160" width="140" height="140" style={{ flexShrink: 0 }}>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--color-surface-strong)" strokeWidth={sw} />
        {segments.map((s, i) => {
          const len = (s.value / total) * C;
          const dash = `${len} ${C - len}`;
          const offset = -acc;
          acc += len;
          return (
            <circle key={i} cx={cx} cy={cy} r={r} fill="none"
              stroke={s.color} strokeWidth={sw}
              strokeDasharray={dash} strokeDashoffset={offset}
              transform={`rotate(-90 ${cx} ${cy})`}
            />
          );
        })}
        <text x={cx} y={cy - 4} textAnchor="middle"
          fontFamily="var(--font-mono)" fontSize="11"
          fill="var(--color-muted)" letterSpacing="0.5"
          style={{ textTransform: 'uppercase' }}>
          Spent
        </text>
        <text x={cx} y={cy + 14} textAnchor="middle"
          fontFamily="var(--font-sans)" fontWeight="600" fontSize="20"
          fill="var(--color-ink)" letterSpacing="-0.4"
          style={{ fontVariantNumeric: 'tabular-nums lining-nums' }}>
          $1,847
        </text>
      </svg>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {segments.map((s, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: 8, font: 'var(--type-body-sm)' }}>
            <span style={{
              width: 8, height: 8, borderRadius: 999, background: s.color, flexShrink: 0,
              alignSelf: 'center',
            }} />
            <span style={{ flex: 1, fontWeight: 500 }}>{s.label}</span>
            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-muted)' }}>
              ${s.value.toFixed(0)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};

Object.assign(window, { Home, Analysis });
