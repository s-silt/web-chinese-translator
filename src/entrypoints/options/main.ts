import { createApp } from 'vue'
import '../../components/theme.css'
import '../../components/styles/cyber.css'
import '../../components/styles/glass.css'
import './options.css'
import { initUiPreferences } from '../../components/ui-preferences'
import App from './App.vue'

// 挂载前按缓存设置语言与外观，避免首屏闪烁
initUiPreferences()
createApp(App).mount('#app')
