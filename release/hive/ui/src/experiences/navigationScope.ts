import type { Route } from '../lib/router'
import { href } from '../lib/router'
import { NAV_ITEMS, isActive, placesFor, scopedItems, type NavScope } from '../shell/navItems'
import type { Feature } from '../features/registry'
import { targetFor } from './targets'

/** Reuse the exact host navigation scope. No role table, server grant or second destination registry. */
export function routeOffered(route: Route, scope: NavScope): boolean {
  if (!NAV_ITEMS.some((item) => item.admin && isActive(item, route))) return true
  const offered = scopedItems(scope)
  // Rules remains reachable to a member as the existing Inbox -> Rules place.
  return offered.some((item) => isActive(item, route)) || offered.some((item) => placesFor(item, scope.admin).some((place) => href(place.route) === href(route)))
}
export function featureOffered(feature: Feature, scope: NavScope): boolean {
  const target = targetFor(feature)
  return !target || target.kind !== 'route' || routeOffered(target.route, scope)
}
