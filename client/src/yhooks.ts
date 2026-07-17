import { useEffect, useState } from 'react'
import type * as Y from 'yjs'

// Re-render with a plain-JS snapshot of a Y.Array whenever it (deeply) changes.
export function useYArray<T = any>(arr: Y.Array<any>): T[] {
  const [value, setValue] = useState<T[]>(() => arr.toJSON())
  useEffect(() => {
    const update = () => setValue(arr.toJSON())
    arr.observeDeep(update)
    update()
    return () => arr.unobserveDeep(update)
  }, [arr])
  return value
}

// Re-render with a plain-JS snapshot of a Y.Map whenever it changes.
export function useYMap(map: Y.Map<any>): Record<string, any> {
  const [value, setValue] = useState<Record<string, any>>(() => map.toJSON())
  useEffect(() => {
    const update = () => setValue(map.toJSON())
    map.observe(update)
    update()
    return () => map.unobserve(update)
  }, [map])
  return value
}

// Just the keys of a Y.Map, updating only when entries are added/removed/renamed
// (shallow observe — edits inside nested Y.Text values don't re-render the tree).
export function useYMapKeys(map: Y.Map<any>): string[] {
  const [keys, setKeys] = useState<string[]>(() => Array.from(map.keys()))
  useEffect(() => {
    const update = () => setKeys(Array.from(map.keys()))
    map.observe(update)
    update()
    return () => map.unobserve(update)
  }, [map])
  return keys
}

export interface AwarenessPeer {
  id: number
  user?: { name: string; color: string; id: string }
  cursor?: { nx: number; ny: number }
}

// All awareness states except our own.
export function useAwareness(awareness: any): AwarenessPeer[] {
  const [peers, setPeers] = useState<AwarenessPeer[]>([])
  useEffect(() => {
    if (!awareness) return
    const update = () => {
      const local = awareness.clientID
      const list: AwarenessPeer[] = []
      awareness.getStates().forEach((state: any, id: number) => {
        if (id !== local) list.push({ id, ...state })
      })
      setPeers(list)
    }
    awareness.on('change', update)
    update()
    return () => awareness.off('change', update)
  }, [awareness])
  return peers
}
