// 左サイドバー（エクスプローラー）を手動で畳む／戻すトグル。
//
// 用語サイドパネル（sidepanel.inline.ts）を開くと右サイドバーの枠をパネルが引き継ぐため、
// 狭い画面では本文が圧迫される。左を畳めるようにしておくと、パネルを開いた状態でも
// 本文幅を確保できる（1440px で 本文 670px → 955px）。
//
// パネルとは独立した機能として動く。自動では畳まない（勝手に動くと戸惑うため）。

const STORAGE_KEY = "sidebar-left-collapsed"
const COLLAPSED_CLASS = "sidebar-left-collapsed"
const BUTTON_ID = "sidebar-toggle"

function isCollapsed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true"
  } catch {
    return false
  }
}

function persist(collapsed: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, String(collapsed))
  } catch {
    // localStorage が使えない環境でも動作自体は継続させる
  }
}

function apply(collapsed: boolean) {
  document.body.classList.toggle(COLLAPSED_CLASS, collapsed)
  const button = document.getElementById(BUTTON_ID)
  if (button) {
    button.setAttribute("aria-expanded", String(!collapsed))
    button.setAttribute("aria-label", collapsed ? "サイドバーを開く" : "サイドバーを畳む")
    button.title = collapsed ? "サイドバーを開く" : "サイドバーを畳む"
  }
}

function createButton(): HTMLButtonElement {
  const button = document.createElement("button")
  button.id = BUTTON_ID
  button.type = "button"
  // 開閉どちらの状態でも同じ位置に出したいので、body 直下に固定配置する
  button.innerHTML = `<span class="sidebar-toggle-bar"></span><span class="sidebar-toggle-bar"></span><span class="sidebar-toggle-bar"></span>`
  button.addEventListener("click", () => {
    const next = !document.body.classList.contains(COLLAPSED_CLASS)
    apply(next)
    persist(next)
  })
  return button
}

function setupSidebarToggle() {
  // SPA遷移のたびに呼ばれる。ボタンは body 直下に置き続けるので作り直さない
  let button = document.getElementById(BUTTON_ID) as HTMLButtonElement | null
  if (!button) {
    button = createButton()
    document.body.appendChild(button)
  }
  apply(isCollapsed())
}

document.addEventListener("nav", setupSidebarToggle)
document.addEventListener("render", setupSidebarToggle)
