import { createApp } from 'vue'
import '../../components/theme.css'
import '../../components/styles/cyber.css'
import '../../components/styles/glass.css'
import { initUiPreferences } from '../../components/ui-preferences'
import App from './App.vue'

initUiPreferences()
createApp(App).mount('#app')
