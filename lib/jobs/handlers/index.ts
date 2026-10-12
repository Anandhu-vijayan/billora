// lib/jobs/handlers/index.ts — job handler registration seam.
//
// Importing this module for its side effects is what finally lets a worker tick
// claim work: worker.ts only claims job types that have a registered handler, so
// until BOTH Phase-4 handlers are registered here the queue stays inert by
// design. The worker route imports this file so a deployed tick processes real
// work; a misconfigured deploy that forgets to import it claims nothing rather
// than half-processing (guarded by a contract test).
import { registerJobHandler } from '@/lib/jobs/worker'
import { extractInvoice } from '@/lib/jobs/handlers/extract-invoice'
import { buildRegister } from '@/lib/jobs/handlers/build-register'

registerJobHandler('invoice_extraction', extractInvoice)
registerJobHandler('register_generation', buildRegister)
