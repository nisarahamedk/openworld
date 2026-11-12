import { MedusaContainer } from "@medusajs/framework/types"

// World test: an hourly job, like a reconciliation cron.
let runs = 0
export default async function hourlyReconcile(container: MedusaContainer) {
  runs++
  const logger = container.resolve("logger")
  logger.info(`TESSJOB run=${runs} at=${new Date().toISOString()}`)
}

export const config = {
  name: "hourly-reconcile",
  schedule: "0 * * * *",
}
