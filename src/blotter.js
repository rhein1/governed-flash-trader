// Blotter: settled PAPER positions marked to LIVE market prices.
//
// No funds move, ever. Paper fills are re-valued at live Definitive Flash v1
// quotes (reverse side of each position) to compute unrealized P&L in USD.
// Every snapshot line carries the honesty label: paper fills at live quoted
// prices — no real funds moved.
//
// Credentials: none needed. The default key is Definitive's own published
// public dev key — the same one the official @definitive-fi/flash-mcp server
// uses when no user key is configured (PUBLIC_DEV_KEY in its dist). It is
// rate-limited and quote-only. Set FLASH_API_KEY to override it with your own.

import fs from "node:fs";
import path from "node:path";
import { loadStore } from "./store.js";
import { getQuote } from "./flash.js";

// Published by DefinitiveCo/flash-mcp (dist/flashClient.js): "Public docs dev
// key — used only when the trader has not configured their own." Verified
// 2026-09-15 returning real quotes. Safe to ship in code; it cannot trade.
export const PUBLIC_DEV_KEY = "dpka_513a2bd7_57a2_46d2_927b_2a3857fe271b";

export const BLOTTER_DISCLAIMER =
  "paper fills marked at live quoted prices — no real funds moved";

export function blotterKeyInfo() {
  return process.env.FLASH_API_KEY
    ? { key: process.env.FLASH_API_KEY, source: "env:FLASH_API_KEY" }
    : { key: PUBLIC_DEV_KEY, source: "public-dev-key" };
}

// Extract markable positions from settled paper receipts. A position needs a
// paper fill (entry price + size); legs without one are reported as skipped,
// never invented.
export function paperPositions(store) {
  const positions = [];
  const skipped = [];
  for (const r of store.receipts ?? []) {
    if (r.outcome !== "settled" || r.mode !== "paper") continue;
    const orders = r.stages?.submission?.orders ?? [];
    const fills = r.stages?.settlement?.fills ?? [];
    for (let i = 0; i < orders.length; i++) {
      const order = orders[i];
      const fill = fills[i]?.fills?.[0];
      const ctx = { receiptId: r.receiptId, signalId: r.signalId, orderId: order.orderId };
      if (!order.side || !order.targetAsset || !order.contraAsset) {
        skipped.push({ ...ctx, reason: "no position fields (receipt predates blotter)" });
        continue;
      }
      const entryPx = Number(fill?.price);
      // Buy legs: units = target units received. Sell legs: units = target
      // units spent (the position size). Both from evidence, never guessed.
      const units = order.side === "buy" ? Number(fill?.qtyOut) : Number(order.qty);
      if (!fill || !(entryPx > 0) || !(units > 0)) {
        skipped.push({ ...ctx, reason: "no entry fill" });
        continue;
      }
      positions.push({
        ...ctx,
        direction: order.side === "buy" ? "LONG" : "SHORT",
        side: order.side,
        orderType: order.orderType,
        targetChain: order.targetChain,
        contraChain: order.contraChain ?? order.targetChain,
        targetAsset: order.targetAsset,
        contraAsset: order.contraAsset,
        units,
        entryPx,
      });
    }
  }
  return { positions, skipped };
}

// Mark one position to a live quote of the reverse side.
// LONG (paper buy): live SELL quote for `units` -> proceeds vs cost.
// SHORT (paper sell): live BUY quote spending the entry proceeds -> buyback vs proceeds.
export async function markPosition(position, { apiKey, fetchImpl = fetch }) {
  const base = {
    targetChain: position.targetChain,
    contraChain: position.contraChain,
    targetAsset: position.targetAsset,
    contraAsset: position.contraAsset,
    orderType: "market",
    maxSlippage: "0.05",
    maxPriceImpact: "0.05",
  };
  if (position.direction === "LONG") {
    const q = await getQuote({
      apiKey,
      orderRequest: { ...base, side: "sell", qty: String(position.units) },
      fetchImpl,
    });
    const proceedsUsd = Number(q?.to?.notional);
    if (!(proceedsUsd > 0)) throw blotterError("live quote unusable (no to.notional)");
    const costUsd = position.units * position.entryPx;
    const markPx = proceedsUsd / position.units;
    return { markPx, pnlUsd: proceedsUsd - costUsd, pnlPct: (proceedsUsd - costUsd) / costUsd };
  }
  const entryProceedsUsd = position.units * position.entryPx;
  const q = await getQuote({
    apiKey,
    orderRequest: { ...base, side: "buy", qty: String(entryProceedsUsd) },
    fetchImpl,
  });
  const buyPx = entryProceedsUsd / Number(q?.to?.amount);
  if (!(buyPx > 0)) throw blotterError("live quote unusable (no to.amount)");
  const buybackUsd = position.units * buyPx;
  return { markPx: buyPx, pnlUsd: entryProceedsUsd - buybackUsd, pnlPct: (entryProceedsUsd - buybackUsd) / entryProceedsUsd };
}

function blotterError(msg) {
  const err = new Error(msg);
  err.code = "BLOTTER_QUOTE_FAILED";
  return err;
}

// One mark-to-market pass: read settled paper positions, mark each at live
// prices, append a single snapshot line to the blotter JSONL. Positions whose
// live quote fails are listed under skipped, never dropped silently.
export async function updateBlotter({ storePath, blotterPath, fetchImpl = fetch }) {
  const { key: apiKey, source: keySource } = blotterKeyInfo();
  const store = loadStore(storePath);
  const { positions, skipped } = paperPositions(store);
  const marked = [];
  const ts = new Date().toISOString();
  for (const p of positions) {
    try {
      const m = await markPosition(p, { apiKey, fetchImpl });
      marked.push({
        receiptId: p.receiptId,
        signalId: p.signalId,
        orderId: p.orderId,
        direction: p.direction,
        orderType: p.orderType,
        asset: `${p.targetChain}:${p.targetAsset}`,
        units: p.units,
        entryPx: round6(p.entryPx),
        markPx: round6(m.markPx),
        pnlUsd: round2(m.pnlUsd),
        pnlPct: round4(m.pnlPct),
        quotedAt: ts,
      });
    } catch (err) {
      skipped.push({
        receiptId: p.receiptId,
        signalId: p.signalId,
        orderId: p.orderId,
        reason: `mark failed: ${err.message}`,
      });
    }
  }
  const totalPnlUsd = round2(marked.reduce((a, m) => a + m.pnlUsd, 0));
  const snapshot = {
    snapshotId: `blotter-${ts.replace(/[:.]/g, "")}`,
    ts,
    disclaimer: BLOTTER_DISCLAIMER,
    venue: "paper",
    prices: "live-flash-v1-quotes",
    keySource,
    positions: marked,
    totals: { positions: marked.length, totalPnlUsd },
    skipped,
  };
  fs.mkdirSync(path.dirname(blotterPath), { recursive: true });
  fs.appendFileSync(blotterPath, JSON.stringify(snapshot) + "\n");
  return snapshot;
}

const round2 = (n) => Math.round(n * 100) / 100;
const round4 = (n) => Math.round(n * 10000) / 10000;
const round6 = (n) => Math.round(n * 1e6) / 1e6;
