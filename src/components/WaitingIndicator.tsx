// WaitingIndicator: marcador geométrico de "respuesta en curso" — una cruz que se
// ensambla (4 brazos convergiendo al centro) y un núcleo en diamante que parpadea,
// en el mismo lenguaje biselado/angular de AppFrame y las cards. Sin spinner circular.

const CYCLE = '1.8s'

interface WaitingIndicatorProps {
  label?: string
}

export default function WaitingIndicator({
  label = 'ESPERANDO RESPUESTA…',
}: WaitingIndicatorProps) {
  return (
    <div role="status" aria-label={label} className="flex items-center gap-3">
      <span aria-hidden="true" className="relative block size-5">
        <span className="oc-cross-arm-y top-0 left-[8px] h-2 w-1" style={{ animationDelay: '0s', animationDuration: CYCLE }} />
        <span className="oc-cross-arm-x right-0 top-[8px] h-1 w-2" style={{ animationDelay: '0.15s', animationDuration: CYCLE }} />
        <span className="oc-cross-arm-y bottom-0 left-[8px] h-2 w-1" style={{ animationDelay: '0.3s', animationDuration: CYCLE }} />
        <span className="oc-cross-arm-x left-0 top-[8px] h-1 w-2" style={{ animationDelay: '0.45s', animationDuration: CYCLE }} />
        <span className="oc-cross-core top-[8px] left-[8px] size-1" style={{ animationDelay: '0.6s', animationDuration: CYCLE }} />
      </span>
      <span className="text-[10px] tracking-[2px] text-dim">{label}</span>
    </div>
  )
}
