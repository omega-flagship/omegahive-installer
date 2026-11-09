import { isHelper } from '../scene/helperGroups'

/** Names shown in the UI drop an implicit "Omega" prefix: OmegaDesign shows as Design (Jon, 2026-10-04).
 *  Display only: ids and stored names never change, and edit fields keep the real name.
 *  Product names stay whole, and a bare "Omega" (or Omega followed by a space) is left alone. */
const KEEP = new Set(['OmegaHive', 'OmegaClaw', 'OmegaClaws'])

/** A request helper's host name (`<template_id> <4 hex>`, scene/helperGroups) is never shown: it reads "Helper". Where
 *  its team is known, the map and the mind card say "Helper <n>" (helperLabels). */
export function shown(name: string | null | undefined): string {
  if (!name) return name ?? ''
  if (isHelper({ name })) return 'Helper'
  return name.replace(/(^|[\s(/·-])Omega(?=[A-Z][a-z])([A-Za-z]+)/g, (whole, lead: string, rest: string) =>
    KEEP.has('Omega' + rest) ? whole : lead + rest)
}
