import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type MinTicks, type RhOptionRow } from '../lib/api'
import { accountLabel, fmtNum } from '../lib/format'
import { optionLabel } from '../lib/optionPositions'
import { qtyFromPercent, dollarPreset, priceText, shareText, type OptionIntent } from '../lib/ticketIntent'
import {
  estimateLine,
  locateContract,
  noPositionNote,
  optionChips,
  optionPositionLine,
  parseSession,
  parseTif,
  positionLine,
  SETTING_OPT_TIF,
  SETTING_SESSION,
  SETTING_TIF,
  sellQtyProblem,
  stepPrice,
} from '../lib/ticketUi'
import {
  agenticAccounts,
  approvalPill,
  buildEquityArgs,
  buildOptionArgs,
  chainsOf,
  findContract,
  midPrice,
  nextOptionPrice,
  optionLegLabel,
  optionStrikes,
  pickChain,
  reviewDisabled,
  roundToTick,
  rowsForChain,
  tickFor,
  ticketAccountProblem,
  ticketDisabledReason,
  type EquityForm,
  type OptionForm,
} from '../lib/orderUi'
import { isSymbol, validateEquity, validateOption } from '../lib/orderValidation'
import { draftFields } from '../lib/riskHelper'
import { ticketKey, useOrdersStore, type Ticket } from '../stores/orders'
import { connectState, useRhStore } from '../stores/rh'
import { useTicketIntentStore } from '../stores/ticketIntent'
import { StrikeCheckPanel } from './StrikeCheck'
import { useDeskStatsStore } from '../stores/deskStats'
import { OrderReview } from './OrderReview'
import { RiskHelper } from './RiskHelper'
import { useRiskStore } from '../stores/risk'

type Tab = 'stock' | 'option'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Order ticket: Stock and single-leg Option tabs, agentic accounts only. Everything goes review -> place through the typed commands. */
export function OrderTicketPane() {
  const { status, connecting, connectError, accounts } = useRhStore()
  const connected = connectState({ status, connecting, connectError }) === 'connected'
  const reason = ticketDisabledReason(connected, accounts)
  if (reason) {
    return (
      <div className="pane-empty" data-testid="ticket-disabled">
        {reason}
      </div>
    )
  }
  return <Ticket />
}

function Ticket() {
  const accounts = useRhStore((s) => s.accounts)
  // ONE selected account for the whole app: this selector, Positions, Orders, approvals and "Check Orders" all use it
  const rhAccount = useRhStore((s) => s.account)
  const chartSymbol = useRhStore((s) => s.chartSymbol)
  const quotes = useRhStore((s) => s.quotes)
  const phase = useOrdersStore((s) => s.phase)
  const reviewKey = useOrdersStore((s) => s.reviewKey)
  const approvalSetting = useOrdersStore((s) => s.approvalSetting)
  const positions = useRhStore((s) => s.positions)
  const optionPositions = useRhStore((s) => s.optionPositions)
  const portfolio = useRhStore((s) => s.portfolio)
  const positionsLoading = useRhStore((s) => s.positionsLoading)
  const positionsError = useRhStore((s) => s.positionsError)
  const intentSeq = useTicketIntentStore((s) => s.seq)

  const agentic = useMemo(() => agenticAccounts(accounts), [accounts])
  const [tab, setTab] = useState<Tab>('stock')
  const accountProblem = ticketAccountProblem(accounts, rhAccount)
  const account = accountProblem ? '' : (rhAccount ?? '')

  // ---- stock form ----
  const [symbol, setSymbol] = useState(chartSymbol)
  const [side, setSide] = useState<EquityForm['side']>('buy')
  const [type, setType] = useState<EquityForm['type']>('limit')
  const [sizeMode, setSizeMode] = useState<EquityForm['sizeMode']>('quantity')
  const [quantity, setQuantity] = useState('')
  const [dollars, setDollars] = useState('')
  const [limit, setLimit] = useState('')
  const [stop, setStop] = useState('')
  const [tif, setTif] = useState<EquityForm['tif']>('gfd')
  const [session, setSession] = useState<EquityForm['session']>('regular_hours')

  // ---- option form ----
  const [under, setUnder] = useState(chartSymbol)
  const [optSide, setOptSide] = useState<OptionForm['side']>('buy')
  const [effect, setEffect] = useState<OptionForm['effect']>('open')
  const [optQty, setOptQty] = useState('1')
  const [optPrice, setOptPrice] = useState('')
  const [optTif, setOptTif] = useState<OptionForm['tif']>('gfd')
  const [optType, setOptType] = useState<'call' | 'put'>('call')
  const [expirations, setExpirations] = useState<string[]>([])
  const [expiration, setExpiration] = useState('')
  const [rows, setRows] = useState<RhOptionRow[]>([])
  const [strike, setStrike] = useState<number | null>(null)
  const [chainBusy, setChainBusy] = useState(false)
  const [chainError, setChainError] = useState('')
  const [chainSymbol, setChainSymbol] = useState('')
  const [chainId, setChainId] = useState('') // primary chain id from the server
  const [chainPick, setChainPick] = useState('')
  const [minTicks, setMinTicks] = useState<MinTicks | null>(null)
  const chainSeq = useRef(0)
  /** A fill from a position / order asks the ticket to load the chain to ONE contract (matched by instrument id). */
  const [pendingContract, setPendingContract] = useState<OptionIntent | null>(null)
  const wantContract = useRef<string | null>(null)
  /** The last mid this form filled into the option price field (a price that still equals it may be replaced by the next mid). */
  const autoPrice = useRef<string | null>(null)

  useEffect(() => {
    setSymbol(chartSymbol)
    setUnder(chartSymbol)
  }, [chartSymbol])

  // Time in force and session are remembered between orders (validated on load; a bad stored value is ignored).
  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const [t, ses, ot] = await Promise.all([api.settingGet(SETTING_TIF), api.settingGet(SETTING_SESSION), api.settingGet(SETTING_OPT_TIF)])
        if (!live) return
        const a = parseTif(t)
        if (a) setTif(a)
        const b = parseSession(ses)
        if (b) setSession(b)
        const c = parseTif(ot)
        if (c) setOptTif(c)
      } catch {
        // settings are a convenience; defaults stay
      }
    })()
    return () => {
      live = false
    }
  }, [])
  const remember = (key: string, value: string) => {
    void api.settingSet(key, value).catch(() => undefined)
  }

  const stockSym = symbol.trim().toUpperCase()
  const underSym = under.trim().toUpperCase()
  const watched = tab === 'stock' ? stockSym : underSym

  // A fill (Close / Add / row click / Cancel & edit) only sets fields here. It never reviews or places; the store already
  // discarded any open review, and the key effect below keeps doing so for every manual edit.
  useEffect(() => {
    const i = useTicketIntentStore.getState().take()
    if (!i) return
    if (i.kind === 'equity') {
      setTab('stock')
      if (i.symbol !== stockSym) {
        setQuantity('')
        setDollars('')
        setLimit('')
        setStop('')
      }
      setSymbol(i.symbol)
      if (i.side) setSide(i.side)
      if (i.orderType) setType(i.orderType)
      if (i.dollars !== undefined) {
        setSizeMode('dollars')
        setDollars(i.dollars)
      } else if (i.quantity !== undefined) {
        setSizeMode('quantity')
        setQuantity(i.quantity)
      }
      if (i.limit !== undefined) setLimit(i.limit)
      if (i.stop !== undefined) setStop(i.stop)
    } else {
      setTab('option')
      setUnder(i.underlying)
      setOptSide(i.side)
      setEffect(i.effect)
      setOptQty(i.quantity)
      setPendingContract(i)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intentSeq])

  // live bid/ask/last through the shared poller (only valid symbols: one bad symbol would fail the whole batch)
  useEffect(() => {
    useRhStore.getState().watchQuotes('ticket', isSymbol(watched) ? [watched] : [])
    return () => useRhStore.getState().watchQuotes('ticket', [])
  }, [watched])

  useEffect(() => {
    if (account) void useOrdersStore.getState().loadApprovalSetting(account)
  }, [account])

  const quote = quotes[watched]

  // A different underlying (typed or from the chart) invalidates everything loaded for the old one:
  // chain rows, expirations, strike, contract and price. In-flight chain loads are orphaned.
  useEffect(() => {
    chainSeq.current += 1
    setRows([])
    setExpirations([])
    setExpiration('')
    setStrike(null)
    setOptPrice('')
    setChainSymbol('')
    setMinTicks(null)
    setChainBusy(false)
    setChainError('')
    autoPrice.current = null
  }, [underSym])

  const loadExpirations = async () => {
    const my = ++chainSeq.current
    setChainBusy(true)
    setChainError('')
    setRows([])
    setStrike(null)
    setExpiration('')
    try {
      const c = await api.rhOptionChain(underSym, null)
      if (my !== chainSeq.current) return
      setChainSymbol(c.chain.symbol)
      setChainId(c.chain.id)
      setChainPick('')
      setMinTicks(c.chain.min_ticks ?? null)
      setExpirations(c.chain.expiration_dates)
      setExpiration(c.chain.expiration_dates[0] ?? '')
    } catch (e) {
      if (my === chainSeq.current) setChainError(msg(e))
    } finally {
      if (my === chainSeq.current) setChainBusy(false)
    }
  }

  useEffect(() => {
    if (!expiration) return
    const my = ++chainSeq.current
    setChainBusy(true)
    setChainError('')
    api
      .rhOptionChain(underSym, expiration)
      .then((c) => {
        if (my !== chainSeq.current) return
        setChainSymbol(c.chain.symbol)
        setChainId(c.chain.id)
        setMinTicks(c.chain.min_ticks ?? null)
        setRows(c.rows)
      })
      .catch((e) => {
        if (my === chainSeq.current) setChainError(msg(e))
      })
      .finally(() => {
        if (my === chainSeq.current) setChainBusy(false)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expiration])

  // Load the chain to the contract a fill asked for: chain header (expirations), then that expiration's rows.
  // Declared after the underlying-reset effect so it runs after it in the same commit.
  useEffect(() => {
    const p = pendingContract
    if (!p) return
    setPendingContract(null)
    wantContract.current = p.optionId
    const my = ++chainSeq.current
    setChainBusy(true)
    setChainError('')
    setRows([])
    setStrike(null)
    setExpiration('')
    setExpirations([])
    setOptPrice(p.limit ?? '')
    autoPrice.current = null
    api
      .rhOptionChain(p.underlying, null)
      .then((c) => {
        if (my !== chainSeq.current) return
        setChainSymbol(c.chain.symbol)
        setChainId(c.chain.id)
        setChainPick('')
        setMinTicks(c.chain.min_ticks ?? null)
        setExpirations(c.chain.expiration_dates)
        if (p.expiration && c.chain.expiration_dates.includes(p.expiration)) {
          setExpiration(p.expiration) // the expiration effect loads the rows
        } else {
          wantContract.current = null
          setChainError(`Expiration ${p.expiration ?? '?'} is not in the chain for ${p.underlying}. Pick the contract manually.`)
          setChainBusy(false)
        }
      })
      .catch((e) => {
        if (my !== chainSeq.current) return
        wantContract.current = null
        setChainError(msg(e))
        setChainBusy(false)
      })
  }, [pendingContract])

  const chains = useMemo(() => chainsOf(rows), [rows])
  const activeChain = pickChain(chains, chainPick, chainId)
  const chainRows = useMemo(() => rowsForChain(rows, activeChain), [rows, activeChain])
  const strikes = useMemo(() => optionStrikes(chainRows, optType), [chainRows, optType])
  // keep a valid strike: nearest to the underlying's last price when the list changes
  useEffect(() => {
    if (strikes.length === 0) return setStrike(null)
    if (strike !== null && strikes.includes(strike)) return
    const last = quotes[underSym]?.last_trade_price
    setStrike(last == null ? strikes[Math.floor(strikes.length / 2)]! : strikes.reduce((b, s) => (Math.abs(s - last) < Math.abs(b - last) ? s : b)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strikes])

  // After a fill: select exactly the contract by instrument id (never a neighbour strike).
  useEffect(() => {
    const want = wantContract.current
    if (!want || rows.length === 0) return
    wantContract.current = null
    const loc = locateContract(rows, want)
    if (!loc) {
      setStrike(null)
      setChainError('The contract of this order or position is not in the loaded chain. Pick it manually.')
      return
    }
    setOptType(loc.type)
    setChainPick(loc.chainId)
    setStrike(loc.strike)
  }, [rows])

  const contract = strike === null ? undefined : findContract(chainRows, optType, strike)
  // ATR for the (informational) strike check: only the chart's DAILY ATR of this underlying
  const deskStats = useDeskStatsStore((d) => d.stats)
  const dailyAtr = deskStats && deskStats.symbol === underSym && deskStats.tf === '1D' ? deskStats.atr : null
  const contractId = contract?.instrument.id ?? ''
  // Prefill the mid (rounded to the chain's tick) only into an empty field, or one that still holds the previous auto mid.
  useEffect(() => {
    const n = nextOptionPrice({ current: optPrice, lastAuto: autoPrice.current, mid: midPrice(contract, minTicks) })
    autoPrice.current = n.auto
    if (n.price !== optPrice) setOptPrice(n.price)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contractId])

  const legs = useMemo(
    () => (contractId ? [{ option_id: contractId, label: optionLegLabel(rows, contractId, chainSymbol || underSym) }] : []),
    [contractId, rows, chainSymbol, underSym],
  )

  // M11: picking a contract in the option ticket shows that contract on the chart (option mode). Display only: nothing is sent.
  useEffect(() => {
    if (tab !== 'option' || !contract) return
    const i = contract.instrument
    useRhStore.getState().setChartOption({
      id: i.id,
      label: optionLabel({ chain_symbol: i.chain_symbol || chainSymbol || underSym, expiration_date: i.expiration_date, strike_price: i.strike_price, option_type: i.option_type }),
      underlying: underSym,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contractId, tab])

  // ---- M10 conveniences (all derived from what is already loaded; nothing here sends anything) ----
  const stockPos = positions.find((p) => p.symbol === stockSym)
  const optPos = contractId ? optionPositions.find((p) => p.option_id.toLowerCase() === contractId.toLowerCase()) : undefined
  const bp = portfolio?.buying_power ?? null
  const limitNum = Number(limit)
  const stockPx =
    (type === 'limit' || type === 'stop_limit') && limitNum > 0
      ? limitNum
      : side === 'buy'
        ? (quote?.ask_price || quote?.last_trade_price || 0)
        : (quote?.bid_price || quote?.last_trade_price || 0)
  const heldQty = stockPos?.quantity ?? null
  const sellBase = heldQty !== null && heldQty > 0 ? Math.min(Math.max(stockPos?.shares_available_for_sells ?? heldQty, 0), heldQty) : 0
  const presetBase = side === 'sell' ? sellBase : bp !== null && bp > 0 && stockPx > 0 ? bp / stockPx : 0
  const fractionalOk = type === 'market' && session === 'regular_hours'
  // Selling with an empty quantity prefills the position size (only when the side, symbol or position changes; a cleared field stays cleared).
  useEffect(() => {
    if (side !== 'sell' || sizeMode !== 'quantity' || quantity !== '' || sellBase <= 0) return
    const t = shareText(sellBase)
    if (t) setQuantity(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [side, stockSym, sizeMode, sellBase > 0])

  const ticket: Ticket =
    tab === 'stock'
      ? { kind: 'equity', args: buildEquityArgs({ account, symbol, side, type, sizeMode, quantity, dollars, limit, stop, tif, session }) }
      : { kind: 'option', args: buildOptionArgs({ account, optionId: contractId, side: optSide, effect, quantity: optQty, price: optPrice, tif: optTif }), legs }
  const key = ticketKey(ticket)
  useEffect(() => {
    useOrdersStore.getState().ticketEdited(key)
  }, [key])

  // R tools (M18, informational): when a review comes back, store the planned risk under its review id using the values the ticket
  // REVIEWED (symbol, side, quantity, price); when the order is `placed`, attach its id to that draft. Nothing here changes, blocks or
  // delays the order: a failure only leaves this order without an R.
  const reviewId = useOrdersStore((s) => s.reviewOut?.review_id ?? null)
  const outcome = useOrdersStore((s) => s.outcome)
  useEffect(() => {
    if (phase !== 'reviewed' || !reviewId) return
    const t = useOrdersStore.getState().ticket
    if (!t) return
    const helper = useRiskStore.getState().helper
    const mult = useRiskStore.getState().settings?.default_option_stop_mult ?? 2
    const out =
      t.kind === 'equity'
        ? draftFields({ kind: 'equity', args: t.args }, helper, { entryHint: stockPx > 0 ? stockPx : null, defaultStopMult: mult })
        : draftFields({ kind: 'option', args: t.args, underlying: (t.legs?.[0]?.label ?? '').split(' ')[0] || underSym }, helper, { entryHint: null, defaultStopMult: mult })
    if (out.fields) void useRiskStore.getState().putDraft(reviewId, out.fields)
    else if (out.reason) useRiskStore.setState({ note: `No R saved for this order: ${out.reason}` })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, reviewId])
  useEffect(() => {
    if (phase !== 'placed' || !reviewId || outcome?.kind !== 'placed') return
    const id = (outcome.order as Record<string, unknown>)?.id
    if (typeof id !== 'string' || id === '') return
    // only an order that has a saved draft (the helper was used) is looked up
    if (useRiskStore.getState().drafts.some((d) => d.review_id === reviewId)) void useRiskStore.getState().attachOrder(reviewId, id)
  }, [phase, reviewId, outcome])

  const problem =
    accountProblem ??
    (ticket.kind === 'equity'
      ? (validateEquity(ticket.args) ?? (sizeMode === 'quantity' ? sellQtyProblem(side, quantity, stockPos) : null))
      : contractId
        ? (validateOption(ticket.args) ?? (legs[0]?.label === null ? 'This contract is not in the loaded chain.' : null))
        : 'Load the chain and pick a contract.')
  const busy = phase === 'reviewing' || phase === 'placing'
  const blocked = phase === 'unknown'
  // an order waiting in the Robinhood app: reviewing the SAME ticket again would queue a duplicate; edit it or finish that one first
  const waiting = phase === 'awaitingApproval' && key === reviewKey

  const pill = approvalPill(approvalSetting[account])
  const positionsLoaded = !positionsLoading && positionsError === ''
  const stockNote = sizeMode === 'quantity' ? noPositionNote(side, stockPos, positionsLoaded) : null
  const cq = contract?.quote
  const estimate =
    tab === 'stock'
      ? estimateLine({
          side, quantity: sizeMode === 'quantity' ? quantity : '', dollars: sizeMode === 'dollars' ? dollars : undefined,
          limit: type === 'limit' || type === 'stop_limit' ? limit : undefined, bid: quote?.bid_price, ask: quote?.ask_price, last: quote?.last_trade_price, buyingPower: bp,
        })
      : estimateLine({ side: optSide, quantity: optQty, limit: optPrice, bid: cq?.bid, ask: cq?.ask, last: cq?.mark, buyingPower: bp, multiplier: 100 })
  const pickStockPrice = (n: number) => {
    setLimit(priceText(n))
    if (type === 'market' || type === 'stop_market') setType('limit')
  }
  const chips = optionChips(cq)
  const optTick = tickFor(minTicks, Number(optPrice) > 0 ? Number(optPrice) : (chips.mid ?? 0.01))

  return (
    <div className="ticket">
      <div className="pane-head">
        <select aria-label="Account" value={account} onChange={(e) => void useRhStore.getState().selectAccount(e.target.value)}>
          {account === '' && <option value="">Select an agentic account</option>}
          {agentic.map((a) => (
            <option key={a.account_number} value={a.account_number}>
              {accountLabel(a)}
            </option>
          ))}
        </select>
        <span className={`pill ${pill.cls}`} title={pill.title} data-testid="approvals-pill">
          {pill.text}
        </span>
      </div>
      <div className="ticket-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'stock'} className={tab === 'stock' ? 'active' : ''} onClick={() => { useOrdersStore.getState().clearFinished(); setTab('stock') }}>
          Stock
        </button>
        <button role="tab" aria-selected={tab === 'option'} className={tab === 'option' ? 'active' : ''} onClick={() => { useOrdersStore.getState().clearFinished(); setTab('option') }}>
          Option (single leg)
        </button>
      </div>

      {tab === 'stock' ? (
        <div className="ticket-form">
          <label>
            Symbol
            <input aria-label="Symbol" value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} />
          </label>
          <Quote q={quote} onPick={pickStockPrice} />
          <div className="pos-line" data-testid="position-line">
            {positionLine(stockPos, quote?.last_trade_price ?? null)}
          </div>
          <div className="seg" role="group" aria-label="Side">
            <button className={side === 'buy' ? 'active buy' : ''} onClick={() => setSide('buy')}>
              Buy
            </button>
            <button className={side === 'sell' ? 'active sell' : ''} onClick={() => setSide('sell')}>
              Sell
            </button>
          </div>
          <label>
            Type
            <select value={type} onChange={(e) => setType(e.target.value as EquityForm['type'])}>
              <option value="limit">Limit</option>
              <option value="market">Market</option>
              <option value="stop_limit">Stop limit</option>
              <option value="stop_market">Stop market</option>
            </select>
          </label>
          <label>
            Size
            <select value={sizeMode} onChange={(e) => setSizeMode(e.target.value as EquityForm['sizeMode'])}>
              <option value="quantity">Shares</option>
              <option value="dollars">Dollars</option>
            </select>
          </label>
          {sizeMode === 'quantity' ? (
            <label>
              Quantity
              <input aria-label="Quantity" inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
            </label>
          ) : (
            <label>
              Dollar amount
              <input aria-label="Dollar amount" inputMode="decimal" value={dollars} onChange={(e) => setDollars(e.target.value)} />
            </label>
          )}
          <div className="chips" role="group" aria-label="Size presets" data-testid="size-presets">
            {sizeMode === 'quantity' ? (
              <>
                <span>{side === 'sell' ? 'of position' : 'of buying power'}</span>
                {([25, 50, 75, 100] as const).map((pct) => (
                  <button
                    key={pct}
                    disabled={!(presetBase > 0)}
                    title={presetBase > 0 ? `${pct}% = ${qtyFromPercent(pct, presetBase, fractionalOk) || '0'} shares` : side === 'sell' ? 'No position to size from' : 'Needs buying power and a price'}
                    onClick={() => setQuantity(qtyFromPercent(pct, presetBase, fractionalOk))}
                  >
                    {pct === 100 ? 'Max' : `${pct}%`}
                  </button>
                ))}
              </>
            ) : (
              [100, 500, 1000].map((n) => (
                <button key={n} onClick={() => setDollars(dollarPreset(n))}>
                  {`$${n.toLocaleString('en-US')}`}
                </button>
              ))
            )}
          </div>
          <RiskHelper
            kind="equity"
            symbol={stockSym}
            side={side}
            entryHint={stockPx > 0 ? stockPx : null}
            creditHint={null}
            increment={fractionalOk ? 0.001 : 1}
            onUse={(q) => {
              setSizeMode('quantity')
              setQuantity(q)
            }}
          />
          {(type === 'limit' || type === 'stop_limit') && (
            <label>
              Limit price
              <span className="stepper">
                <button type="button" aria-label="Lower limit price" onClick={() => setLimit(stepPrice(limit, -1, 0.01))}>-</button>
                <input aria-label="Limit price" inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} />
                <button type="button" aria-label="Raise limit price" onClick={() => setLimit(stepPrice(limit, 1, 0.01))}>+</button>
              </span>
            </label>
          )}
          {(type === 'stop_market' || type === 'stop_limit') && (
            <label>
              Stop price
              <input aria-label="Stop price" inputMode="decimal" value={stop} onChange={(e) => setStop(e.target.value)} />
            </label>
          )}
          <label>
            Time in force
            <select value={tif} onChange={(e) => { const v = e.target.value as EquityForm['tif']; setTif(v); remember(SETTING_TIF, v) }}>
              <option value="gfd">Day (gfd)</option>
              <option value="gtc">Good til cancelled (gtc)</option>
            </select>
          </label>
          <label>
            Session
            <select value={session} onChange={(e) => { const v = e.target.value as EquityForm['session']; setSession(v); remember(SETTING_SESSION, v) }}>
              <option value="regular_hours">Regular hours</option>
              <option value="extended_hours">Extended hours</option>
              <option value="all_day_hours">All day</option>
            </select>
          </label>
        </div>
      ) : (
        <div className="ticket-form">
          <label>
            Underlying
            <input aria-label="Underlying" value={under} onChange={(e) => setUnder(e.target.value.toUpperCase())} />
          </label>
          <Quote q={quote} />
          <div className="row">
            <button disabled={!isSymbol(underSym) || chainBusy} onClick={() => void loadExpirations()}>
              {chainBusy ? 'Loading...' : 'Load chain'}
            </button>
            {chainError && <span className="err">{chainError}</span>}
          </div>
          <label>
            Expiration
            <select value={expiration} disabled={expirations.length === 0} onChange={(e) => setExpiration(e.target.value)}>
              {expirations.length === 0 && <option value="">-</option>}
              {expirations.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
          </label>
          {chains.length > 1 && (
            <label title="This underlying has more than one option chain for this expiry (index or adjusted contracts). Pick the one you mean.">
              Chain
              <select value={activeChain} onChange={(e) => setChainPick(e.target.value)}>
                {chains.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.symbol}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="seg" role="group" aria-label="Call or put">
            <button className={optType === 'call' ? 'active' : ''} onClick={() => setOptType('call')}>
              Call
            </button>
            <button className={optType === 'put' ? 'active' : ''} onClick={() => setOptType('put')}>
              Put
            </button>
          </div>
          <label>
            Strike
            <select value={strike ?? ''} disabled={strikes.length === 0} onChange={(e) => setStrike(Number(e.target.value))}>
              {strikes.length === 0 && <option value="">-</option>}
              {strikes.map((s) => (
                <option key={s} value={s}>
                  {fmtNum(s)}
                </option>
              ))}
            </select>
          </label>
          {contract?.quote && <Greeks q={contract.quote} />}
          {effect === 'open' && contract && (
            <StrikeCheckPanel symbol={underSym} row={contract} side={optSide} spot={quotes[underSym]?.last_trade_price ?? null} atr={dailyAtr} />
          )}
          {contract && (
            <div className="pos-line" data-testid="option-position-line">
              {optionPositionLine(optPos)}
            </div>
          )}
          {(chips.bid !== undefined || chips.ask !== undefined || chips.mid !== undefined) && (
            <div className="chips" role="group" aria-label="Option price chips" data-testid="option-chips">
              <span>set price</span>
              {chips.bid !== undefined && <button onClick={() => setOptPrice(chips.bid!.toFixed(2))}>{`Bid ${fmtNum(chips.bid)}`}</button>}
              {chips.mid !== undefined && <button onClick={() => setOptPrice(roundToTick(chips.mid!, tickFor(minTicks, chips.mid!)))}>{`Mid ${fmtNum(chips.mid)}`}</button>}
              {chips.ask !== undefined && <button onClick={() => setOptPrice(chips.ask!.toFixed(2))}>{`Ask ${fmtNum(chips.ask)}`}</button>}
            </div>
          )}
          <div className="seg" role="group" aria-label="Side">
            <button className={optSide === 'buy' ? 'active buy' : ''} onClick={() => setOptSide('buy')}>
              Buy
            </button>
            <button className={optSide === 'sell' ? 'active sell' : ''} onClick={() => setOptSide('sell')}>
              Sell
            </button>
          </div>
          <label>
            Effect
            <select value={effect} onChange={(e) => setEffect(e.target.value as OptionForm['effect'])}>
              <option value="open">Open</option>
              <option value="close">Close</option>
            </select>
          </label>
          <label>
            Contracts
            <input aria-label="Contracts" inputMode="numeric" value={optQty} onChange={(e) => setOptQty(e.target.value)} />
          </label>
          <RiskHelper
            kind="option"
            symbol={underSym}
            side={optSide}
            entryHint={null}
            creditHint={Number(optPrice) > 0 ? Number(optPrice) : null}
            increment={1}
            onUse={(q) => setOptQty(q)}
          />
          <label>
            Limit price
            <span className="stepper">
              <button type="button" aria-label="Lower option limit price" onClick={() => setOptPrice(stepPrice(optPrice, -1, optTick))}>-</button>
              <input aria-label="Option limit price" inputMode="decimal" value={optPrice} onChange={(e) => setOptPrice(e.target.value)} />
              <button type="button" aria-label="Raise option limit price" onClick={() => setOptPrice(stepPrice(optPrice, 1, optTick))}>+</button>
            </span>
          </label>
          <label>
            Time in force
            <select value={optTif} onChange={(e) => { const v = e.target.value as OptionForm['tif']; setOptTif(v); remember(SETTING_OPT_TIF, v) }}>
              <option value="gfd">Day (gfd)</option>
              <option value="gtc">Good til cancelled (gtc)</option>
            </select>
          </label>
        </div>
      )}

      {estimate && (
        <div className="est-line pad" data-testid="estimate">
          {estimate}
        </div>
      )}
      {stockNote && tab === 'stock' && (
        <div className="pos-note pad" data-testid="no-position-note">
          {stockNote}
        </div>
      )}
      {problem && (
        <div className="muted small pad" data-testid="validation">
          {problem}
        </div>
      )}
      <div className="review-actions pad">
        <button className="primary" disabled={reviewDisabled({ problem, phase, key, reviewKey })} onClick={() => void useOrdersStore.getState().review(ticket)}>
          {phase === 'reviewing' ? 'Reviewing...' : 'Review order'}
        </button>
        {blocked && <span className="muted small">Resolve the unconfirmed order first.</span>}
        {waiting && <span className="muted small">Waiting for your approval in the Robinhood app. Change the order to review a new one.</span>}
      </div>
      <OrderReview />
    </div>
  )
}

/** Bid / ask / last. With `onPick` each known price is a chip that sets the limit price (and switches to a limit order). */
function Quote({ q, onPick }: { q: { bid_price: number | null; ask_price: number | null; last_trade_price: number | null } | undefined; onPick?: (n: number) => void }) {
  const cell = (label: string, v: number | null | undefined) => (
    <span>
      {label}{' '}
      {onPick && v !== null && v !== undefined && v > 0 ? (
        <button type="button" className="chip-btn" title={`Use ${fmtNum(v)} as the limit price`} onClick={() => onPick(v)}>
          {fmtNum(v)}
        </button>
      ) : (
        <b>{fmtNum(v)}</b>
      )}
    </span>
  )
  return (
    <div className="ticket-quote" data-testid="quote">
      {cell('bid', q?.bid_price)}
      {cell('ask', q?.ask_price)}
      {cell('last', q?.last_trade_price)}
    </div>
  )
}

function Greeks({ q }: { q: NonNullable<RhOptionRow['quote']> }) {
  const g = (label: string, v: number | null, dp = 2) => (
    <span key={label}>
      {label} <b>{fmtNum(v, dp)}</b>
    </span>
  )
  return (
    <div className="ticket-quote greeks" data-testid="greeks">
      {g('bid', q.bid)}
      {g('ask', q.ask)}
      {g('mark', q.mark)}
      {g('delta', q.delta)}
      {g('gamma', q.gamma, 3)}
      {g('theta', q.theta)}
      {g('vega', q.vega)}
      {g('IV', q.implied_volatility)}
      {g('OI', q.open_interest, 0)}
    </div>
  )
}
