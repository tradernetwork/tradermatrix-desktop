import { ErrorBoundary } from './workspace/ErrorBoundary'
import { Workspace } from './workspace/Workspace'

export default function App() {
  return (
    <ErrorBoundary label="TraderMatrix Desktop">
      <Workspace />
    </ErrorBoundary>
  )
}
