import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script'
import { isFirefoxBuild } from '../shared/extension'
import { startPageTranslation } from '../translation/controller'
import { currentYouTubeInputFrameTopUrl } from '../translation/input-frame'

export default defineUnlistedScript(() => {
  if (!isFirefoxBuild() && currentYouTubeInputFrameTopUrl() !== undefined) {
    void startPageTranslation({ inputOnly: true })
  }
})
