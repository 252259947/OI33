const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
test('scoreboard search intersects native filters, survives refresh, and frozen names stay visible', {skip:process.env.OI33_LAYOUT_TEST!=='1'}, async () => {
  const {chromium}=require('playwright');
  const js=require('esbuild').buildSync({entryPoints:[path.join(root,'frontend/scoreboard-usability.ts')],bundle:true,format:'iife',globalName:'ScoreboardUX',write:false}).outputFiles[0].text;
  const css=read('node_modules/@hydrooj/ui-default/public/theme-4.58.4.css')+read('frontend/oi33-design-system.css')+read('frontend/scoreboard-names.css')+read('frontend/scoreboard-usability.css');
  const problems=Array.from({length:25},(_,i)=>`<col class="col--problem"><!-- ${i} -->`).join('');
  const colgroup=`<colgroup><col class="col--rank"><col class="col--user"><col class="col--total_score">${problems}</colgroup>`;
  const head=`<table class="data-table section__table-header">${colgroup}<thead><tr><th class="col--rank">排名</th><th class="col--user">用户</th><th class="col--total_score">得分</th>${Array.from({length:25},(_,i)=>`<th class="col--problem">${String.fromCharCode(65+i)}</th>`).join('')}</tr></thead></table>`;
  const body=()=>`<table class="data-table">${colgroup}<tbody>${['张同学','李同学','阿卜杜热合曼·阿卜杜热依木'].map((name,i)=>`<tr><td class="col--rank">${i+1}</td><td class="col--user"><button class="star user--${17+i}" data-uid="${17+i}">☆</button><a class="user-profile-name" href="/user/${17+i}">${name}</a></td><td class="col--total_score">${300-i*100}</td>${Array.from({length:25},()=>'<td class="col--record"><a href="/record/fixture">100</a></td>').join('')}</tr>`).join('')}</tbody></table>`;
  const board=()=>`<div class="oi33-scoreboard" data-fragment-id="scoreboard"><div class="section__body no-padding"><div class="section__table-container">${head}${body()}</div></div></div>`;
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    for(const dark of [false,true]) for(const width of [1366,1920]) {
      const page=await browser.newPage({viewport:{width,height:900}});
      await page.setContent(`<html class="page--contest_scoreboard ${dark?'theme--dark':''}"><style>${css}.section{margin:24px}.data-table{min-width:2800px}.data-table col.col--problem{width:88px}</style><section class="section"><div class="oi33-scoreboard-tools"><label for="oi33-scoreboard-query">查找学生</label><input id="oi33-scoreboard-query" type="search"><button data-scoreboard-clear>清除</button><span data-scoreboard-count></span></div>${board()}<p data-scoreboard-empty hidden>无匹配</p></section></html>`);
      await page.addScriptTag({content:js+';window.cleanupBoard=ScoreboardUX.installScoreboardUsability();'});
      const count=page.locator('[data-scoreboard-count]');
      await count.waitFor();
      await page.waitForFunction(()=>document.querySelector('[data-scoreboard-count]').textContent==='显示 3 / 3 人');
      await page.locator('#oi33-scoreboard-query').fill('李');
      await page.waitForFunction(()=>document.querySelector('[data-scoreboard-count]').textContent==='显示 1 / 3 人');
      assert.equal(await page.locator('tbody tr:visible .user-profile-name').innerText(),'李同学');
      // Native group/star filtering uses inline display, asynchronously.
      await page.locator('tbody tr').nth(1).evaluate(row=>row.style.display='none');
      await page.waitForFunction(()=>document.querySelector('[data-scoreboard-count]').textContent==='显示 0 / 3 人');
      assert.equal(await page.locator('[data-scoreboard-empty]').isVisible(),true);
      await page.locator('tbody tr').nth(1).evaluate(row=>row.style.display='');
      await page.waitForFunction(()=>document.querySelector('[data-scoreboard-count]').textContent==='显示 1 / 3 人');
      await page.locator('.oi33-scoreboard').evaluate((el,html)=>el.outerHTML=html,board());
      await page.waitForFunction(()=>document.querySelector('tbody tr').classList.contains('oi33-scoreboard-search-hidden'));
      assert.equal(await page.locator('#oi33-scoreboard-query').inputValue(),'李');
      await page.locator('#oi33-scoreboard-query').fill('19');
      await page.waitForFunction(()=>document.querySelector('tbody tr:last-child').getBoundingClientRect().height>0);
      assert.match(await page.locator('tbody tr:visible .user-profile-name').innerText(),/阿卜杜/);
      await page.locator('[data-scoreboard-clear]').click();
      await page.waitForFunction(()=>document.querySelector('[data-scoreboard-count]').textContent==='显示 3 / 3 人');
      const before=await page.locator('tbody tr:first-child .col--user').boundingBox();
      await page.locator('.section__table-container').evaluate(el=>el.scrollLeft=650);
      await page.waitForFunction(()=>document.querySelector('.section__table-container').scrollLeft===650);
      const after=await page.locator('tbody tr:first-child .col--user').boundingBox();
      assert.ok(Math.abs(before.x-after.x)<2,JSON.stringify({before,after}));
      const header=await page.locator('thead .col--user').boundingBox();
      assert.ok(Math.abs(header.x-after.x)<2,JSON.stringify({header,after}));
      const colors=await page.locator('tbody tr:first-child .col--user').evaluate(el=>({bg:getComputedStyle(el).backgroundColor,fg:getComputedStyle(el).color}));
      assert.notEqual(colors.bg,'rgba(0, 0, 0, 0)');assert.notEqual(colors.bg,colors.fg);
      assert.equal(await page.locator('tbody tr:first-child .col--rank').innerText(),'1');
      assert.equal(await page.locator('tbody tr:first-child .col--total_score').innerText(),'300');
      assert.equal(await page.locator('tbody tr:first-child .col--record a').first().getAttribute('href'),'/record/fixture');
      await page.close();
    }
  } finally {await browser.close();}
});
