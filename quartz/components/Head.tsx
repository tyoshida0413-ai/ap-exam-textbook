import { i18n } from "../i18n"
import { FullSlug, getFileExtension, joinSegments, pathToRoot } from "../util/path"
import { CSSResourceToStyleElement, JSResourceToScriptElement } from "../util/resources"
import { googleFontHref, googleFontSubsetHref } from "../util/theme"
import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"
import { unescapeHTML } from "../util/escape"

// メインCSS(index-*.css)が空シートで読み込まれた場合に、キャッシュを回避して読み直す。
// Safariでこの1ファイルだけ取得に失敗し、失敗レスポンスがキャッシュされて
// リロードしても直らない事象が実機で確認されたため（2026-08-05, 罠#31）。
// data-persist を付けてSPA遷移では再実行しない。
const cssGuardScript = `
(function () {
  var MAX = 3, tries = 0, lastTry = 0, settled = false
  function findLink() {
    var links = document.querySelectorAll('link[rel="stylesheet"]')
    for (var i = 0; i < links.length; i++) {
      if (/\\/index-[^/]*\\.css/.test(links[i].href)) return links[i]
    }
    return null
  }
  // 「ファイルが取れたか」ではなく「CSSが実際に効いているか」で判定する。
  // 取得失敗の現れ方は環境依存（Safari実機=cssRulesが0件 / Chrome遮断=SecurityError）で
  // 一定しないため、適用結果そのものを見る。
  // 判定に使うのは custom.scss 冒頭の目印 --main-css-loaded だけ。
  // 画面幅やレイアウトに依存する値を使うと、スマホ幅で誤発火する（2026-08-05 実測）。
  function isLoaded(l) {
    var root = document.documentElement
    if (getComputedStyle(root).getPropertyValue("--main-css-loaded").trim() !== "") return true
    try { return !!(l.sheet && l.sheet.cssRules && l.sheet.cssRules.length > 0) }
    catch (e) { return false }
  }
  function record(status, href) {
    try {
      var log = JSON.parse(localStorage.getItem("cssGuardLog") || "[]")
      log.unshift({ t: new Date().toISOString(), status: status, href: href, w: window.innerWidth })
      localStorage.setItem("cssGuardLog", JSON.stringify(log.slice(0, 20)))
    } catch (e) {}
  }
  function check() {
    if (settled) return
    var link = findLink()
    if (!link) return
    if (isLoaded(link)) {
      if (tries > 0) { settled = true; record("recovered", link.href) }
      return
    }
    var now = Date.now()
    if (tries >= MAX) { settled = true; record("failed", link.href); return }
    if (now - lastTry < 1200) return
    tries++; lastTry = now
    var base = link.getAttribute("href").split("?")[0]
    var fresh = document.createElement("link")
    fresh.rel = "stylesheet"
    fresh.type = "text/css"
    fresh.setAttribute("data-persist", "true")
    fresh.href = base + "?cssguard=" + now
    fresh.addEventListener("load", check)
    fresh.addEventListener("error", check)
    link.parentNode.insertBefore(fresh, link.nextSibling)
    link.parentNode.removeChild(link)
    record("retry" + tries, fresh.href)
    setTimeout(check, 1500)
  }
  var first = findLink()
  if (first) { first.addEventListener("load", check); first.addEventListener("error", check) }
  document.addEventListener("DOMContentLoaded", check)
  window.addEventListener("load", check)
  setTimeout(check, 2000)
  setTimeout(check, 6000)
})()
`

export default (() => {
  const Head: QuartzComponent = ({
    cfg,
    fileData,
    externalResources,
    ctx,
  }: QuartzComponentProps) => {
    const titleSuffix = cfg.pageTitleSuffix ?? ""
    const title =
      (fileData.frontmatter?.title ?? i18n(cfg.locale).propertyDefaults.title) + titleSuffix
    const description =
      fileData.frontmatter?.socialDescription ??
      fileData.frontmatter?.description ??
      unescapeHTML(fileData.description?.trim() ?? i18n(cfg.locale).propertyDefaults.description)

    const { css, js, additionalHead } = externalResources

    const url = new URL(`https://${cfg.baseUrl ?? "example.com"}`)
    const path = url.pathname as FullSlug
    const baseDir = fileData.slug === "404" ? path : pathToRoot(fileData.slug!)
    const iconPath = joinSegments(baseDir, "static/icon.png")

    // Url of current page
    const socialUrl =
      fileData.slug === "404" ? url.toString() : joinSegments(url.toString(), fileData.slug!)

    const usesCustomOgImage = ctx.cfg.plugins.emitters.some((e) => e.name === "CustomOgImages")
    const ogImageDefaultPath = `https://${cfg.baseUrl}/static/og-image.png`

    const coreStylesheet = css[0]?.content
    const coreScript = js.find(
      (r) => r.loadTime === "beforeDOMReady" && r.contentType === "external",
    )

    return (
      <head>
        <title>{title}</title>
        <meta charSet="utf-8" />
        {coreStylesheet && <link rel="preload" href={coreStylesheet} as="style" />}
        {coreScript && coreScript.contentType === "external" && (
          <link rel="preload" href={coreScript.src} as="script" />
        )}
        {cfg.theme.cdnCaching && cfg.theme.fontOrigin === "googleFonts" && (
          <>
            <link rel="preconnect" href="https://fonts.googleapis.com" />
            <link rel="preconnect" href="https://fonts.gstatic.com" />
            <link rel="stylesheet" href={googleFontHref(cfg.theme)} />
            {cfg.theme.typography.title && (
              <link rel="stylesheet" href={googleFontSubsetHref(cfg.theme, cfg.pageTitle)} />
            )}
          </>
        )}
        <link rel="preconnect" href="https://cdnjs.cloudflare.com" crossOrigin="anonymous" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />

        <meta name="og:site_name" content={cfg.pageTitle}></meta>
        <meta property="og:title" content={title} />
        <meta property="og:type" content="website" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content={title} />
        <meta name="twitter:description" content={description} />
        <meta property="og:description" content={description} />
        <meta property="og:image:alt" content={description} />

        {!usesCustomOgImage && (
          <>
            <meta property="og:image" content={ogImageDefaultPath} />
            <meta property="og:image:url" content={ogImageDefaultPath} />
            <meta name="twitter:image" content={ogImageDefaultPath} />
            <meta
              property="og:image:type"
              content={`image/${getFileExtension(ogImageDefaultPath) ?? "png"}`}
            />
          </>
        )}

        {cfg.baseUrl && (
          <>
            <meta property="twitter:domain" content={cfg.baseUrl}></meta>
            <meta property="og:url" content={socialUrl}></meta>
            <meta property="twitter:url" content={socialUrl}></meta>
          </>
        )}

        <link rel="icon" href={iconPath} />
        <meta name="description" content={description} />
        <meta name="generator" content="Quartz" />

        {css.map((resource) => CSSResourceToStyleElement(resource, true))}
        <script data-persist="true" dangerouslySetInnerHTML={{ __html: cssGuardScript }} />
        {js
          .filter((resource) => resource.loadTime === "beforeDOMReady")
          .map((res) => JSResourceToScriptElement(res, true))}
        {additionalHead.map((resource) => {
          if (typeof resource === "function") {
            return resource(fileData)
          } else {
            return resource
          }
        })}
      </head>
    )
  }

  return Head
}) satisfies QuartzComponentConstructor
