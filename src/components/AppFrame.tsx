// AppFrame: marco HUD exterior — borde, brackets de esquina, etiquetas de riel
// y overlay de vidrio/CRT. Envolvé el layout raíz de la app con este componente.

import type { ReactNode } from 'react'

export default function AppFrame({ children }: { children: ReactNode }) {
  const bracket = 'absolute size-3.5 border-amber z-45'
  return (
    <div className="h-dvh box-border bg-bg p-3.5 font-mono text-sm text-ink">
      <div className="relative h-full border border-line-hi">
        <span className={`${bracket} -top-0.5 -left-0.5 border-t-2 border-l-2`} />
        <span className={`${bracket} -top-0.5 -right-0.5 border-t-2 border-r-2`} />
        <span className={`${bracket} -bottom-0.5 -left-0.5 border-b-2 border-l-2`} />
        <span className={`${bracket} -bottom-0.5 -right-0.5 border-b-2 border-r-2`} />
        <span className="absolute -top-2 left-6 z-45 bg-bg px-2 text-[10px] tracking-[3px] text-dim">OPENCLAW // TERMINAL DE ENLACE</span>
        <span className="absolute -top-2 right-6 z-45 bg-bg px-2 text-[10px] tracking-[3px] text-faint">NODO 01</span>
        <span className="absolute -bottom-2 right-6 z-45 bg-bg px-2 text-[10px] tracking-[3px] text-faint">SYS 6.2</span>
        <div className="oc-glass pointer-events-none absolute inset-0 z-40" />
        <div className="flex h-full overflow-hidden">{children}</div>
      </div>
    </div>
  )
}
