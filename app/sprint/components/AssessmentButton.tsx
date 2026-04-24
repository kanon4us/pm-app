'use client'
import { Button } from 'antd'

interface AssessmentButtonProps {
  historyLoading: boolean
  onRunNew: () => void
}

// Primary action button for starting an FVI assessment.
// Disabled while history is loading (so the user can't start before we know if a run is in-progress).
// Resume capability is deferred — see docs/superpowers/plans for the next iteration.
export function AssessmentButton({ historyLoading, onRunNew }: AssessmentButtonProps) {
  return (
    <Button disabled={historyLoading} onClick={onRunNew}>
      AI Assessment
    </Button>
  )
}
