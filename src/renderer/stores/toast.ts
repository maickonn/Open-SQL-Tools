import { toast } from 'sonner'
import { errorMessage } from '../gateways/api'

export const notify = {
  success(msg: string): void {
    toast.success(msg)
  },
  info(msg: string): void {
    toast(msg)
  },
  error(err: unknown): void {
    toast.error(errorMessage(err), { duration: 8000 })
  }
}
