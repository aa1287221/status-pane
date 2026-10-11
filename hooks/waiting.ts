// Skeleton: final signatures, wrong values, so the tests fail on assertions (red step 1).
import type { SideIo, SideLoc, SideOk } from './sidefile'
import type { Res, Snap, WaitingData, WaitingDown, WaitingItem } from './state'

export const WAITING_NAME_RE = /^waiting\.([A-Za-z0-9][A-Za-z0-9_-]{0,63})\.json$/

export type WaitingIo = SideIo & { list: (path: string) => Promise<{ name: string }[]> }
export type RawItem = { id: string; state: 'open' | 'closed'; updatedSec: number; sinceSec: number; what: string; closedBy: string | null }
export type Merged = { id: string; state: 'open' | 'closed'; host: string; updatedSec: number; sinceSec: number; what: string }
export type WaitingRow = { id: string; host: string; age: string; date: string; due: boolean; what: string }
export type WaitingView = { rows: WaitingRow[]; total: number; due: number; down: WaitingDown[] }

export const itemsOf = (_r: SideOk): Res<RawItem[]> => ({ ok: true, v: [] })
export const mergeBoard = (_perHost: { host: string; items: RawItem[] }[]): Merged[] => []
export const collectWaiting = async (_io: WaitingIo, _loc: SideLoc, _nowMs: number): Promise<WaitingData> => ({ items: [], openTotal: 0, down: [], skipped: 0 })
export const waitingView = (_data: WaitingData, _nowMs: number, _tzMin = 0): WaitingView => ({ rows: [], total: 0, due: 0, down: [] })
export const waitingHead = (_v: WaitingView): { count: string; dueText: string | null } => ({ count: '', dueText: null })
export const waitingHint = (_snap: Snap, _nowMs: number): string | null => null
export type { WaitingItem }
