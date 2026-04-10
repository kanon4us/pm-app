import '@testing-library/jest-dom'

// Ant Design requires window.matchMedia — stub it for jsdom
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
})

// Ant Design uses getComputedStyle for scrollbar size detection — stub it for jsdom
Object.defineProperty(window, 'getComputedStyle', {
  writable: true,
  value: () => ({
    getPropertyValue: () => '',
    overflow: '',
    overflowX: '',
    overflowY: '',
  }),
})
