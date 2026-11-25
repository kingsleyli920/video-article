import { expect, type Page } from '@playwright/test';

/**
 * 页面宽度不超过视口，内容不超出页面的内容栏；列出越界的元素方便定位。
 * 手机模拟下内容过宽时浏览器会缩小页面、把 innerWidth 撑大，所以和配置的视口宽度比，而不是和 innerWidth 比。
 */
export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const viewportWidth = page.viewportSize()!.width;
  const result = await page.evaluate((limit) => {
    const name = (el: Element) => {
      const cls = typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).join('.')}` : '';
      return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${cls}`;
    };
    const pageEl = document.querySelector('.page')!;
    const pageRect = pageEl.getBoundingClientRect();
    const columnRight = pageRect.right - parseFloat(getComputedStyle(pageEl).paddingRight) + window.scrollX;
    const outsideViewport: string[] = [];
    const outsideColumn: string[] = [];
    for (const el of Array.from(pageEl.querySelectorAll('*'))) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0) continue;
      const right = rect.right + window.scrollX;
      if (right > limit + 0.5) outsideViewport.push(`${name(el)} right=${Math.round(right)}`);
      else if (right > columnRight + 0.5) outsideColumn.push(`${name(el)} right=${Math.round(right)} 内容栏=${Math.round(columnRight)}`);
    }
    return { scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth, outsideViewport, outsideColumn };
  }, viewportWidth);
  expect(result.outsideViewport, `超出视口（${viewportWidth}px）右边缘的元素`).toEqual([]);
  expect(result.outsideColumn, '超出页面内容栏的元素').toEqual([]);
  expect(result.scrollWidth, '页面 scrollWidth').toBeLessThanOrEqual(viewportWidth);
  expect(result.innerWidth, '页面没有被缩小以容纳过宽内容').toBe(viewportWidth);
}

/** 元素相对容器的上下留白（px，取整） */
export async function verticalGaps(page: Page, containerSelector: string, childSelector: string): Promise<{ top: number; bottom: number }> {
  return page.locator(containerSelector).evaluate((container, child) => {
    const outer = container.getBoundingClientRect();
    const inner = container.querySelector(child)!.getBoundingClientRect();
    return { top: Math.round(inner.top - outer.top), bottom: Math.round(outer.bottom - inner.bottom) };
  }, childSelector);
}
