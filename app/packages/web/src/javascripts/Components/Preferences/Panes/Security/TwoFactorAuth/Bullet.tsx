import { FunctionComponent } from 'react'

type Props = {
  className?: string
}

const Bullet: FunctionComponent<Props> = ({ className = '' }) => (
  <div className={`bg-text inline-block min-h-1 min-w-1 rounded-full ${className} mr-2`} />
)

export default Bullet
