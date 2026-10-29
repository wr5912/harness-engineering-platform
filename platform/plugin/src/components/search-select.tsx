import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export type SearchSelectOption = { value: string; label: string; description?: string; group?: string; disabled?: boolean }
export type SearchSelectProps = {
  value: string
  options: readonly SearchSelectOption[]
  onChange: (value: string) => void
  label: string
  placeholder?: string
  disabled?: boolean
  required?: boolean
  className?: string
  id?: string
  name?: string
}

/** 搜索只影响候选展示，已选身份始终由调用方维护。 */
export function SearchSelect({ value, options, onChange, label, placeholder = '请选择', disabled, required, className = '', id, name }: SearchSelectProps) {
  const uid = useId()
  const listId = `${uid}-options`
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(-1)
  const [position, setPosition] = useState({ left: 0, top: 0, width: 200, maxHeight: 300 })
  const trigger = useRef<HTMLButtonElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const selected = options.find(item => item.value === value)
  const needle = query.trim().toLocaleLowerCase()
  const visible = options.filter(item => !needle || [item.label, item.value, item.description, item.group].some(text => text?.toLocaleLowerCase().includes(needle)))
  const close = (restore = false) => { setOpen(false); if (restore) trigger.current?.focus() }
  useLayoutEffect(() => {
    if (open && trigger.current && trigger.current.getClientRects().length === 0) setOpen(false)
  })
  function show() {
    if (disabled) return
    setQuery(''); setActive(-1); setOpen(true)
  }
  function choose(option: SearchSelectOption) {
    if (option.disabled) return
    onChange(option.value); close(true)
  }
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect()
      if (!rect) return
      const width = Math.min(Math.max(rect.width, 240), window.innerWidth - 24)
      const below = window.innerHeight - rect.bottom - 12
      const above = rect.top - 12
      const upwards = below < 220 && above > below
      const maxHeight = Math.max(100, Math.min(360, upwards ? above - 6 : below - 6))
      setPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), top: upwards ? Math.max(12, rect.top - maxHeight - 6) : rect.bottom + 6, width, maxHeight })
    }
    place(); search.current?.focus()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [open])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (!trigger.current?.contains(event.target as Node) && !popup.current?.contains(event.target as Node)) close()
    }
    const focus = (event: FocusEvent) => {
      if (!trigger.current?.contains(event.target as Node) && !popup.current?.contains(event.target as Node)) close()
    }
    document.addEventListener('pointerdown', outside); document.addEventListener('focusin', focus)
    const navigate = () => close()
    window.addEventListener('popstate', navigate); window.addEventListener('hashchange', navigate)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', focus); window.removeEventListener('popstate', navigate); window.removeEventListener('hashchange', navigate) }
  }, [open])
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  function move(direction: number) {
    const enabled = visible.map((item, index) => item.disabled ? -1 : index).filter(index => index >= 0)
    if (!enabled.length) return
    const offset = enabled.indexOf(active)
    const next = enabled[offset < 0 ? direction > 0 ? 0 : enabled.length - 1 : (offset + direction + enabled.length) % enabled.length]
    setActive(next)
    popup.current?.querySelector(`[data-option-index="${next}"]`)?.scrollIntoView?.({ block: 'nearest' })
  }
  return <span className={`hep-search-select ${className}`}>
    {name && <input type="hidden" name={name} value={value}/>}
    <button id={id} ref={trigger} type="button" role="combobox" aria-label={label} aria-required={required} aria-expanded={open} aria-controls={listId} aria-haspopup="listbox" disabled={disabled}
      title={selected?.description || selected?.label || value || placeholder}
      onClick={() => open ? close() : show()} onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); show() } }}>
      <span>{selected?.label || value || placeholder}</span><span aria-hidden="true">⌄</span>
    </button>
    {open && createPortal(<div ref={popup} className="hep-search-popup" style={position} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true) }
      else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); move(event.key === 'ArrowDown' ? 1 : -1) }
      else if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); if (active >= 0 && visible[active]) choose(visible[active]) }
    }}>
      <div className="hep-search-input"><input ref={search} aria-label={`搜索${label}`} aria-controls={listId} aria-activedescendant={active >= 0 ? `${uid}-${active}` : undefined} value={query} placeholder={`搜索${label}`} onChange={event => { setQuery(event.target.value); setActive(-1) }}/>{query && <button type="button" aria-label="清空搜索" onClick={() => { setQuery(''); setActive(-1); search.current?.focus() }}>×</button>}</div>
      <div id={listId} role="listbox" aria-label={label}>
        {visible.length ? visible.map((option, index) => <button id={`${uid}-${index}`} data-option-index={index} type="button" role="option" key={option.value} aria-selected={option.value === value} disabled={option.disabled} data-active={active === index || undefined} onPointerMove={() => setActive(index)} onClick={() => choose(option)}>
          <span><strong>{option.label}</strong>{(option.description || option.group) && <small>{[option.group, option.description].filter(Boolean).join(' · ')}</small>}</span>{option.value === value && <span aria-hidden="true">✓</span>}
        </button>) : <p role="status">没有匹配项</p>}
      </div>
    </div>, trigger.current?.closest('dialog') ?? document.body)}
  </span>
}

export const searchSelectTheme = `
.hep-search-select{font-size:14px;line-height:1.55;display:inline-block;min-width:0;max-width:100%;vertical-align:middle}.hep-search-select>button{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;text-align:left;min-height:36px}.hep-search-select>button>span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hep-search-popup{position:fixed;z-index:1000;display:flex;flex-direction:column;box-sizing:border-box;overflow:hidden;border:1px solid #dce3ed;border-radius:8px;background:#fff;color:#1c2d43;box-shadow:0 8px 28px #16395926;font:14px/1.55 HepNoto,system-ui,"Microsoft YaHei",sans-serif}.hep-search-popup *{box-sizing:border-box}.hep-search-input{position:relative;flex:none;padding:8px;border-bottom:1px solid #dce3ed}.hep-search-input input{width:100%;min-width:0;padding:8px 30px 8px 10px;border:1px solid #dce3ed;border-radius:6px;background:transparent;color:inherit;font:inherit}.hep-search-input>button{position:absolute;right:13px;top:12px;border:0;background:transparent;color:inherit;font:20px/1 inherit;cursor:pointer}.hep-search-popup [role=listbox]{overflow:auto;min-height:0;padding:4px}.hep-search-popup [role=option]{display:flex;align-items:center;justify-content:space-between;width:100%;padding:9px 10px;border:0;border-radius:5px;background:transparent;color:inherit;text-align:left;cursor:pointer;font:inherit}.hep-search-popup strong{font-weight:500}.hep-search-popup small{display:block;color:#607187;font-size:12px;overflow-wrap:anywhere}.hep-search-popup [role=option]:is(:hover,[data-active=true],[aria-selected=true]){background:#eaf3fc;color:#0062ae}.hep-search-popup [role=option]:disabled{opacity:.45;cursor:default}.hep-search-popup p{padding:8px 10px;margin:0;color:#607187}.hep-search-popup :focus-visible{outline:2px solid #0086dd;outline-offset:-2px}body[data-ds-dark-theme] .hep-search-popup{background:#172333;color:#e4ebf3;border-color:#344254}body[data-ds-dark-theme] .hep-search-popup :is(input,.hep-search-input){border-color:#344254}body[data-ds-dark-theme] .hep-search-popup [role=option]:is(:hover,[data-active=true],[aria-selected=true]){background:#203c58;color:#94c9ff}body[data-ds-dark-theme] .hep-search-popup small{color:#acb9ca}
`
