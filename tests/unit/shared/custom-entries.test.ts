import {
  addEntry,
  editEntry,
  filterEntries,
  mergeEntries,
  normalizeEntry,
  parseCustomEntriesJson,
  previewImport,
  removeEntry,
  serializeEntries,
} from '../../../src/shared/custom-entries'

describe('normalizeEntry', () => {
  it('原文合并空白，译文去首尾空白', () => {
    expect(normalizeEntry('  Pull \n  requests ', ' 拉取请求 ')).toEqual(['Pull requests', '拉取请求'])
  })

  it.each([
    ['', '译文'],
    ['原文', ''],
    ['   ', '译文'],
    ['原文', '  '],
  ])('空值 %j / %j → undefined', (source, target) => {
    expect(normalizeEntry(source, target)).toBeUndefined()
  })
})

describe('parseCustomEntriesJson', () => {
  it('解析对象并规范化', () => {
    expect(parseCustomEntriesJson('{"  Code ": " 代码 ", "Issues": "议题"}')).toEqual({ Code: '代码', Issues: '议题' })
  })

  it('丢弃无效项，保留有效项', () => {
    expect(parseCustomEntriesJson('{"Code": "代码", "Bad": 1, "Empty": ""}')).toEqual({ Code: '代码' })
  })

  it('空对象 → 空词条', () => {
    expect(parseCustomEntriesJson('{}')).toEqual({})
  })

  it.each(['', 'not json', '[]', '["Code"]', '"Code"', '1', 'null', '{"Bad": 1}', '{"": "空"}'])(
    '%j → 格式错误',
    (text) => {
      expect(parseCustomEntriesJson(text)).toBeUndefined()
    },
  )

  it('__proto__ 作为普通键，不污染原型', () => {
    const entries = parseCustomEntriesJson('{"__proto__": "原型", "Code": "代码"}')
    expect(entries).toBeDefined()
    expect(Object.getPrototypeOf(entries)).toBe(Object.prototype)
    expect(Object.hasOwn(entries ?? {}, '__proto__')).toBe(true)
    expect(({} as Record<string, unknown>).Code).toBeUndefined()
  })
})

describe('addEntry', () => {
  it('新增词条', () => {
    expect(addEntry({ Code: '代码' }, ' Issues ', '议题')).toEqual({
      ok: true,
      entries: { Code: '代码', Issues: '议题' },
    })
  })

  it('原文已存在 → exists', () => {
    expect(addEntry({ Code: '代码' }, 'Code', '源码')).toEqual({ ok: false, reason: 'exists' })
  })

  it('空值 → invalid', () => {
    expect(addEntry({}, ' ', '代码')).toEqual({ ok: false, reason: 'invalid' })
  })
})

describe('editEntry', () => {
  const entries = { Code: '代码', Issues: '议题', Pulls: '拉取请求' }

  it('改译文', () => {
    expect(editEntry(entries, 'Issues', 'Issues', '问题')).toEqual({
      ok: true,
      entries: { Code: '代码', Issues: '问题', Pulls: '拉取请求' },
    })
  })

  it('改原文并保持顺序', () => {
    const result = editEntry(entries, 'Issues', 'Issue', '议题')
    expect(result.ok && Object.keys(result.entries)).toEqual(['Code', 'Issue', 'Pulls'])
  })

  it('新原文与其他词条重复 → exists', () => {
    expect(editEntry(entries, 'Issues', 'Code', '议题')).toEqual({ ok: false, reason: 'exists' })
  })

  it('清空 → invalid', () => {
    expect(editEntry(entries, 'Issues', 'Issues', '')).toEqual({ ok: false, reason: 'invalid' })
  })

  it('原词条不存在时追加', () => {
    expect(editEntry({ Code: '代码' }, 'Gone', 'New', '新')).toEqual({
      ok: true,
      entries: { Code: '代码', New: '新' },
    })
  })
})

describe('removeEntry / mergeEntries / filterEntries / serializeEntries', () => {
  it('删除词条', () => {
    expect(removeEntry({ Code: '代码', Issues: '议题' }, 'Code')).toEqual({ Issues: '议题' })
  })

  it('合并时导入优先', () => {
    expect(mergeEntries({ Code: '代码', Issues: '议题' }, { Issues: '问题', Wiki: 'Wiki' })).toEqual({
      Code: '代码',
      Issues: '问题',
      Wiki: 'Wiki',
    })
  })

  it('不覆盖时保留现有译文与顺序，只按导入顺序追加新增', () => {
    const merged = mergeEntries({ B: '旧', A: '甲' }, { C: '丙', A: '新', B: '乙' }, false)
    expect(merged).toEqual({ B: '旧', A: '甲', C: '丙' })
    expect(Object.keys(merged)).toEqual(['B', 'A', 'C'])
  })

  it('新添加的在前，按原文或译文筛选，不区分大小写', () => {
    const entries = { Code: '代码', Issues: '议题', 'Pull requests': '拉取请求' }
    expect(filterEntries(entries, '')).toEqual([
      ['Pull requests', '拉取请求'],
      ['Issues', '议题'],
      ['Code', '代码'],
    ])
    expect(filterEntries(entries, ' pull ')).toEqual([['Pull requests', '拉取请求']])
    expect(filterEntries(entries, '议题')).toEqual([['Issues', '议题']])
    expect(filterEntries(entries, 'none')).toEqual([])
  })

  it('导出为缩进 JSON', () => {
    expect(serializeEntries({ Code: '代码' })).toBe('{\n  "Code": "代码"\n}\n')
  })
})

describe('previewImport', () => {
  it('分出新增、覆盖与相同，added 与 changed 按导入的键顺序', () => {
    const preview = previewImport(
      { Code: '代码', Issues: '议题' },
      { Wiki: '维基', Issues: '问题', Code: '代码', Pulls: '拉取' },
    )
    expect(preview.added).toEqual([
      ['Wiki', '维基'],
      ['Pulls', '拉取'],
    ])
    expect(preview.changed).toEqual([{ source: 'Issues', from: '议题', to: '问题' }])
    expect(preview.unchanged).toBe(1)
  })

  it('全部相同或都为空', () => {
    expect(previewImport({ Code: '代码' }, { Code: '代码' })).toEqual({ added: [], changed: [], unchanged: 1 })
    expect(previewImport({}, {})).toEqual({ added: [], changed: [], unchanged: 0 })
  })
})
