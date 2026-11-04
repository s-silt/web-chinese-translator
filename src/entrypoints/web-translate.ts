import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script'
import { isFirefoxBuild } from '../shared/extension'
import { startPageTranslation } from '../translation/controller'

export default defineUnlistedScript(() => {
  if (!isFirefoxBuild()) void startPageTranslation()
})
