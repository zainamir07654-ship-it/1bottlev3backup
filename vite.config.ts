import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const isCapacitor = process.env.CAPACITOR === '1' || mode === 'capacitor'
  return {
    plugins: [react()],
    base: isCapacitor ? './' : '/1bottle-v2-public/',
  }
})
