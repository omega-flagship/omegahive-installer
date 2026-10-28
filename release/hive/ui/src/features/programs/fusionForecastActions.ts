import { askConfirm } from '../../ui/confirm'
import { ForecastComposer, type ForecastDraft } from './fusionForecast'

/** Shared living-UI action: mount ConfirmHost; page assistance cannot approve. */
export async function reviewHumanForecast(controller: ForecastComposer, draft: ForecastDraft): Promise<void> {
  await controller.submit(draft,message=>askConfirm(message,'Publish forecast'))
}
