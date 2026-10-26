/**
 * dsh-bark-notify — Settings → Plugins → "Bark 通知" page.
 *
 * The page renders one form over the Host plugin entry's volatile Config and
 * writes every change through the shared client `configForms` service, which
 * persists to the profile patch layer and applies live: no reload, no restart.
 *
 * Authored in the browser module-loader format (id = package name) and mounted
 * into the Plugins settings section, so it sits beside the shipped tabs without
 * replacing any of them.
 */

window.__ModuleLoader__.load({
  id: 'dsh-bark-notify',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace owned by this page. */
    const NS = 'settings.barkNotify'
    /** Host plugin entry id whose volatile Config this page edits. */
    const ENTRY = 'bark-notify'

    /** Built-in Bark ringtones shipped with the app (Sounds/ in Finb/Bark). */
    const SOUNDS = [
      'alarm', 'anticipate', 'bell', 'birdsong', 'bloom', 'calypso', 'chime', 'choo', 'descent',
      'electronic', 'fanfare', 'glass', 'gotosleep', 'healthnotification', 'horn', 'ladder',
      'mailsent', 'minuet', 'multiwayinvitation', 'newmail', 'newsflash', 'noir', 'paymentsuccess',
      'shake', 'sherwoodforest', 'silence', 'spell', 'suspense', 'telegraph', 'tiptoes',
      'typewriters', 'update',
    ]

    const COPY = {
      zh: {
        tab: 'Bark 通知',
        loading: '读取配置…',
        unavailable: '这台机器上的 Host 没有提供该插件的可编辑配置。',
        notWritable: '当前页面不是本机回环连接，改动只会留在内存里。',
        waiting: '等待 Host 提供该插件的配置…',
        saved: '已保存',
        writeFailed: '写入被拒绝（配置可能已被别处改动）',
        sectionTrigger: '触发时机',
        sectionCard: '卡片内容',
        sectionAlert: '提醒与声音',
        sectionArchive: '归档、去重与点击',
        sectionJobs: '后台任务（可选）',
        sectionDiag: '诊断',
        enabled: '启用推送',
        enabledHint: '关掉后仍保留事件监听，随时打开就恢复推送，不用重启 DSH。',
        server: 'Bark 服务器',
        serverHint: '结尾斜杠会自动去掉；自建与官方 api.day.app 都可用。',
        deviceKeys: '设备 key',
        deviceKeysHint: '每行一个；一台一个 key，同 key 会去重。空列表 = 不推送。',
        notifyOnSuccess: '回合成功时推送',
        notifyOnFailure: '回合失败时推送',
        minTurnSeconds: '最短回合时长（秒）',
        minTurnSecondsHint: '短于这个秒数的回合不推，可滤掉快问快答。0 = 不过滤。',
        sectionWaiting: '等你回应',
        notifyOnQuestion: '弹出选项时推送',
        notifyOnQuestionHint: '我提问让你选（ask_user_question）时推一张「❓ 等你选择」，卡片里带问题和选项。这类时刻回合卡在等你，不会自己结束，所以必须单独推。',
        notifyOnApproval: '需要批准时推送',
        notifyOnApprovalHint: '工具要你批准（权限确认）时推一张「🔐 等你批准」，带原因与工具名。',
        questionOptions: '卡片里列几个选项',
        questionOptionsHint: '0 = 只推问题不列选项；默认 4，超出会写「另有 N 项」。',
        notifyOnJobSuccess: '后台任务完成时推送',
        notifyOnJobSuccessHint: '只推你放到后台跑、且没有工具调用在等的任务；前台命令结束不推。',
        notifyOnJobFailure: '后台任务失败时推送',
        notifyOnJobFailureHint: '任务状态为 failed 时推「❌ 后台任务失败」；被取消或因会话销毁而结束的不推。',
        minJobSeconds: '最短后台任务时长（秒）',
        minJobSecondsHint: '短于这个秒数的后台任务不推，0 = 不过滤。',
        preview: '附带回复摘要',
        previewChars: '摘要字数上限',
        markdown: '正文用 Markdown 渲染',
        markdownHint: '开启后发 markdown 字段（body 被忽略），由 App 渲染粗体/代码/列表；摘要是截断的，可能出现半截标记。',
        level: '中断级别',
        levelHint: 'critical 在静音下也会响，需要 App 里的 critical 权限；passive 不亮屏。',
        levelActive: 'active（默认，立即亮屏）',
        levelTimeSensitive: 'timeSensitive（专注模式可穿透）',
        levelPassive: 'passive（只进通知列表）',
        levelCritical: 'critical（静音也响）',
        volume: 'critical 音量（0–10）',
        call: '持续响铃 30 秒',
        sound: '铃声',
        soundHint: '留空用 App 里的默认铃声；内置铃声名可直接填或从下拉里选。',
        group: '通知分组',
        groupHint: '同组的推送在通知中心与历史里归到一起。',
        icon: '图标 URL',
        image: '图片 URL',
        badge: '角标数字（-1 = 不动）',
        badgeHint: '-1 = 不动角标，0 = 清空角标，>0 = 设置为该数字。',
        collapse: '折叠为同一条通知',
        collapseHint: '开启后每次推送带同一个 id，新的会替换旧的，不在通知中心堆叠。',
        collapseId: '折叠 id',
        collapseIdHint: '可写 {session} / {kind} / {turn} 占位：同一会话、同一类卡片会互相替换；留空渲染时回退为 dsh-turn。',
        ttl: '历史保留（秒，0 = App 设置决定）',
        isArchive: '存入 App 历史',
        isArchiveHint: '关掉会明确发 isArchive=0，不再依赖 App 自己的默认设置。',
        url: '点击跳转 URL',
        action: '点击行为',
        actionDefault: '默认', 
        actionAlert: 'alert（弹出操作面板）',
        actionNone: 'none（只打开 App）',
        copy: '复制内容',
        copyHint: '留空则复制正文。',
        trace: '记录收到的事件',
        traceHint: '把 turn/start、user/message、turn/end、提问/批准、后台任务写进 Host 日志，排查"没收到"时用。',
        retries: '失败重试次数',
        retriesHint: '网络错误、超时、429 或 5xx 时重试；4xx（key 无效等）不重试。0 = 不重试。',
        timeoutMs: '推送超时（毫秒）',
        logFile: '诊断日志文件',
        logFileHint: '每次推送追加一行（含 HTTP 状态）。留空则不写。',
        logMaxBytes: '日志轮转上限（字节）',
        logMaxBytesHint: '超过后把旧日志改名为 .1 再继续写；0 = 不轮转。',
        footer: '改动立即生效：启用开关、设备 key 和所有推送参数下一次推送就按新值执行。',
      },
      en: {
        tab: 'Bark notify',
        loading: 'Reading configuration…',
        unavailable: 'This Host serves no editable configuration for that plugin.',
        notWritable: 'This page is not a loopback connection; edits stay in memory.',
        waiting: 'Waiting for the Host to serve the configuration…',
        saved: 'Saved',
        writeFailed: 'Write refused (the configuration changed elsewhere)',
        sectionTrigger: 'When to notify',
        sectionCard: 'Card content',
        sectionAlert: 'Alert and sound',
        sectionArchive: 'Archive, collapse, tap',
        sectionJobs: 'Background jobs (optional)',
        sectionDiag: 'Diagnostics',
        enabled: 'Enable pushes',
        enabledHint: 'Off keeps the listener armed; turning it back on resumes pushes without a restart.',
        server: 'Bark server',
        serverHint: 'A trailing slash is trimmed; self-hosted and api.day.app both work.',
        deviceKeys: 'Device keys',
        deviceKeysHint: 'One per line. Empty list pushes nothing.',
        notifyOnSuccess: 'Notify on a completed turn',
        notifyOnFailure: 'Notify on a failed turn',
        minTurnSeconds: 'Minimum turn length (seconds)',
        minTurnSecondsHint: 'Shorter turns stay silent. 0 disables the filter.',
        sectionWaiting: 'Waiting for you',
        notifyOnQuestion: 'Notify when a choice is asked',
        notifyOnQuestionHint: 'Pushes "❓ 等你选择" with the question and its options when the agent asks you to choose; that turn never ends on its own, so it needs its own card.',
        notifyOnApproval: 'Notify when approval is required',
        notifyOnApprovalHint: 'Pushes "🔐 等你批准" with the reason and tool name when a tool needs your approval.',
        questionOptions: 'Options listed on the card',
        questionOptionsHint: '0 lists no options; 4 by default, the rest collapse into "另有 N 项".',
        notifyOnJobSuccess: 'Notify when a background job completes',
        notifyOnJobSuccessHint: 'Only jobs nobody is waiting on; a foreground command that the tool call waits for stays silent.',
        notifyOnJobFailure: 'Notify when a background job fails',
        notifyOnJobFailureHint: 'Pushes "❌ 后台任务失败" for a failed job; killed or teardown settlements stay silent.',
        minJobSeconds: 'Minimum job length (seconds)',
        minJobSecondsHint: 'Shorter jobs stay silent. 0 disables the filter.',
        preview: 'Include the reply preview',
        previewChars: 'Preview length',
        markdown: 'Render the body as Markdown',
        markdownHint: 'Sends the markdown field instead of body; the preview is truncated, so a marker may be cut.',
        level: 'Interruption level',
        levelHint: 'critical rings through silent mode and needs the app permission; passive never lights the screen.',
        levelActive: 'active (default)',
        levelTimeSensitive: 'timeSensitive (breaks through Focus)',
        levelPassive: 'passive (list only)',
        levelCritical: 'critical (rings when silenced)',
        volume: 'critical volume (0–10)',
        call: 'Ring for 30 seconds',
        sound: 'Ringtone',
        soundHint: 'Empty uses the app default; built-in names may be typed or picked.',
        group: 'Notification group',
        groupHint: 'Pushes sharing a group stack together in Notification Center and history.',
        icon: 'Icon URL',
        image: 'Image URL',
        badge: 'Badge number (-1 = untouched)',
        badgeHint: '-1 leaves the badge alone, 0 clears it, a positive number sets it.',
        collapse: 'Collapse into one notification',
        collapseHint: 'Every push carries one id, so a new card replaces the previous one.',
        collapseId: 'Collapse id',
        collapseIdHint: 'Supports {session} / {kind} / {turn} placeholders; an empty render falls back to dsh-turn.',
        ttl: 'History retention (seconds, 0 = app setting)',
        isArchive: 'Save to app history',
        isArchiveHint: 'Turning it off sends isArchive=0 explicitly instead of relying on the app default.',
        url: 'Tap-through URL',
        action: 'Tap action',
        actionDefault: 'default',
        actionAlert: 'alert (action sheet)',
        actionNone: 'none (just opens the app)',
        copy: 'Copy payload',
        copyHint: 'Empty copies the body.',
        trace: 'Log received events',
        traceHint: 'Writes turn/start, user/message, turn/end, waiting cards, and job settlements to the Host log.',
        retries: 'Failed-attempt retries',
        retriesHint: 'Retries transport errors, timeouts, 429, and 5xx; 4xx (bad key) is not retried. 0 disables retries.',
        timeoutMs: 'Push timeout (ms)',
        logFile: 'Diagnostics log file',
        logFileHint: 'One line per push with its HTTP status. Empty disables it.',
        logMaxBytes: 'Log rotation size (bytes)',
        logMaxBytesHint: 'Past this size the old file is renamed to .1 and writing continues. 0 disables rotation.',
        footer: 'Changes apply immediately: the enable switch, device keys, and every push parameter take effect on the next push.',
      },
    }

    /** Field descriptors, in render order inside each section. */
    const SECTIONS = [
      {
        title: 'sectionTrigger',
        fields: [
          { key: 'enabled', kind: 'bool' },
          { key: 'server', kind: 'text', hint: true },
          { key: 'deviceKeys', kind: 'list', hint: true, rows: 4 },
          { key: 'notifyOnSuccess', kind: 'bool' },
          { key: 'notifyOnFailure', kind: 'bool' },
          { key: 'minTurnSeconds', kind: 'number', min: 0, max: 86400, hint: true },
        ],
      },
      {
        title: 'sectionWaiting',
        fields: [
          { key: 'notifyOnQuestion', kind: 'bool', hint: true },
          { key: 'questionOptions', kind: 'number', min: 0, max: 12, hint: true },
          { key: 'notifyOnApproval', kind: 'bool', hint: true },
        ],
      },
      {
        title: 'sectionJobs',
        fields: [
          { key: 'notifyOnJobSuccess', kind: 'bool', hint: true },
          { key: 'notifyOnJobFailure', kind: 'bool', hint: true },
          { key: 'minJobSeconds', kind: 'number', min: 0, max: 86400, hint: true },
        ],
      },
      {
        title: 'sectionCard',
        fields: [
          { key: 'preview', kind: 'bool' },
          { key: 'previewChars', kind: 'number', min: 0, max: 400 },
          { key: 'markdown', kind: 'bool', hint: true },
          { key: 'group', kind: 'text', hint: true },
          { key: 'icon', kind: 'text' },
          { key: 'image', kind: 'text' },
        ],
      },
      {
        title: 'sectionAlert',
        fields: [
          {
            key: 'level', kind: 'select', options: [
              ['active', 'levelActive'],
              ['timeSensitive', 'levelTimeSensitive'],
              ['passive', 'levelPassive'],
              ['critical', 'levelCritical'],
            ], hint: true,
          },
          { key: 'volume', kind: 'number', min: 0, max: 10 },
          { key: 'call', kind: 'bool' },
          { key: 'sound', kind: 'sound', hint: true },
        ],
      },
      {
        title: 'sectionArchive',
        fields: [
          { key: 'isArchive', kind: 'bool', hint: true },
          { key: 'ttl', kind: 'number', min: 0, max: 604800 },
          { key: 'collapse', kind: 'bool', hint: true },
          { key: 'collapseId', kind: 'text', hint: true },
          { key: 'badge', kind: 'number', min: -1, max: 99999, hint: true },
          {
            key: 'action', kind: 'select', options: [
              ['', 'actionDefault'],
              ['alert', 'actionAlert'],
              ['none', 'actionNone'],
            ],
          },
          { key: 'url', kind: 'text' },
          { key: 'copy', kind: 'text', hint: true },
        ],
      },
      {
        title: 'sectionDiag',
        fields: [
          { key: 'trace', kind: 'bool', hint: true },
          { key: 'retries', kind: 'number', min: 0, max: 3, hint: true },
          { key: 'timeoutMs', kind: 'number', min: 1000, max: 60000 },
          { key: 'logFile', kind: 'text', hint: true },
          { key: 'logMaxBytes', kind: 'number', min: 0, max: 104857600, hint: true },
        ],
      },
    ]

    /** Shared control styling, inheriting host theme tokens. */
    const controlStyle = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '6px 8px',
      fontSize: 13,
      color: 'var(--dsw-alias-label-primary)',
      background: 'var(--dsw-alias-bg-base)',
      border: '1px solid var(--dsw-alias-border-l1)',
      borderRadius: 6,
      font: 'inherit',
    }

    /**
     * Find the Host namespace this page edits. The describe mirror is the only
     * reader, so the id is discovered rather than guessed: an inserted row can
     * be wrapped by the profile's include tree.
     */
    function useEntryNamespace(configForms) {
      const [ns, setNs] = React.useState(undefined)
      React.useEffect(() => {
        if (configForms === undefined) return undefined
        const mirror = configForms.describe()
        const pick = () => {
          const rows = mirror.getSnapshot().view?.namespaces ?? []
          const row = rows.find((candidate) => candidate.ns === ENTRY)
            ?? rows.find((candidate) => typeof candidate.ns === 'string' && candidate.ns.endsWith(`:${ENTRY}`))
          setNs(row?.ns)
        }
        const off = mirror.subscribe(pick)
        mirror.ensure()
        pick()
        return off
      }, [configForms])
      return ns
    }

    /** Subscribe to one entry's shared form snapshot. */
    function useFormSnapshot(form) {
      const [snapshot, setSnapshot] = React.useState(() => (form === undefined ? undefined : form.getSnapshot()))
      React.useEffect(() => {
        if (form === undefined) {
          setSnapshot(undefined)
          return undefined
        }
        setSnapshot(form.getSnapshot())
        return form.subscribe(() => setSnapshot(form.getSnapshot()))
      }, [form])
      return snapshot
    }

    /** One labelled row: the control plus its hint. */
    function Row(props) {
      const { t, field, value, write } = props
      const [draft, setDraft] = React.useState(undefined)
      const label = t(field.key)
      const hint = field.hint ? t(`${field.key}Hint`) : undefined
      const commit = (next) => {
        setDraft(undefined)
        write(field.key, next)
      }
      let control
      if (field.kind === 'bool') {
        control = h('input', {
          type: 'checkbox',
          checked: value === true,
          style: { width: 16, height: 16, accentColor: 'var(--dsw-alias-brand-primary)' },
          onChange: (event) => commit(event.target.checked),
        })
      } else if (field.kind === 'number') {
        control = h('input', {
          type: 'number',
          min: field.min,
          max: field.max,
          value: draft ?? (typeof value === 'number' ? value : 0),
          style: { ...controlStyle, width: 120 },
          onChange: (event) => setDraft(event.target.value),
          onBlur: () => {
            if (draft !== undefined) commit(Number(draft))
          },
          onKeyDown: (event) => {
            if (event.key === 'Enter' && draft !== undefined) commit(Number(draft))
          },
        })
      } else if (field.kind === 'select') {
        control = h('select', {
          value: typeof value === 'string' ? value : '',
          style: { ...controlStyle, width: 260 },
          onChange: (event) => commit(event.target.value),
        }, field.options.map(([optionValue, labelKey]) => h('option', { key: optionValue, value: optionValue }, t(labelKey))))
      } else if (field.kind === 'list') {
        const text = draft ?? (Array.isArray(value) ? value.join('\n') : '')
        control = h('textarea', {
          rows: field.rows ?? 3,
          value: text,
          spellCheck: false,
          style: { ...controlStyle, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', resize: 'vertical' },
          onChange: (event) => setDraft(event.target.value),
          onBlur: () => {
            if (draft === undefined) return
            commit(draft.split('\n').map((line) => line.trim()).filter((line) => line !== ''))
          },
        })
      } else if (field.kind === 'sound') {
        control = h(React.Fragment, null,
          h('input', {
            type: 'text',
            list: 'dsh-bark-sounds',
            value: draft ?? (typeof value === 'string' ? value : ''),
            spellCheck: false,
            style: { ...controlStyle, width: 260 },
            onChange: (event) => setDraft(event.target.value),
            onBlur: () => {
              if (draft !== undefined) commit(draft.trim())
            },
          }),
          h('datalist', { id: 'dsh-bark-sounds' }, SOUNDS.map((name) => h('option', { key: name, value: name }))),
        )
      } else {
        control = h('input', {
          type: 'text',
          value: draft ?? (typeof value === 'string' ? value : ''),
          spellCheck: false,
          style: controlStyle,
          onChange: (event) => setDraft(event.target.value),
          onBlur: () => {
            if (draft !== undefined) commit(draft.trim())
          },
          onKeyDown: (event) => {
            if (event.key === 'Enter' && draft !== undefined) commit(draft.trim())
          },
        })
      }
      const stacked = field.kind === 'list'
      return h('div', {
        style: {
          display: stacked ? 'block' : 'grid',
          gridTemplateColumns: stacked ? undefined : 'minmax(160px, 240px) 1fr',
          gap: stacked ? 6 : 12,
          alignItems: 'center',
          padding: '10px 0',
          borderTop: '1px solid var(--dsw-alias-border-l1)',
        },
      },
        h('div', { style: { minWidth: 0 } },
          h('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-primary)' } }, label),
          hint === undefined ? null : h('div', { style: { fontSize: 11, lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)', marginTop: 2 } }, hint),
        ),
        h('div', { style: { minWidth: 0 } }, control),
      )
    }

    /** The settings page itself. */
    function Panel(props) {
      const { configForms, t } = props
      const ns = useEntryNamespace(configForms)
      const form = React.useMemo(() => (ns === undefined ? undefined : configForms.get(ns)), [configForms, ns])
      const snapshot = useFormSnapshot(form)
      const [notice, setNotice] = React.useState(undefined)

      React.useEffect(() => {
        if (notice === undefined) return undefined
        const timer = setTimeout(() => setNotice(undefined), 2500)
        return () => clearTimeout(timer)
      }, [notice])

      if (ns === undefined) {
        return h('div', { style: { padding: 16, fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } }, t('waiting'))
      }
      if (snapshot === undefined || snapshot.status === 'loading') {
        return h('div', { style: { padding: 16, fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } }, t('loading'))
      }
      if (snapshot.status !== 'ready') {
        return h('div', { style: { padding: 16, fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } }, t('unavailable'))
      }
      const value = snapshot.value ?? {}
      const write = (key, next) => {
        Promise.resolve(form.set(key, next))
          .then((ok) => setNotice({ ok: ok === true, text: ok === true ? t('saved') : t('writeFailed') }))
          .catch(() => setNotice({ ok: false, text: t('writeFailed') }))
      }
      return h('div', { style: { padding: '4px 16px 24px', maxWidth: 760 } },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10, minHeight: 20 } },
          h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, t('footer')),
          notice === undefined ? null : h('div', {
            style: {
              fontSize: 12,
              color: notice.ok ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)',
            },
          }, notice.text),
        ),
        snapshot.writable === false
          ? h('div', { style: { marginTop: 6, fontSize: 12, color: 'var(--dsw-alias-state-warn-primary)' } }, t('notWritable'))
          : null,
        SECTIONS.map((section) => h('section', { key: section.title, style: { marginTop: 18 } },
          h('div', { style: { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' } }, t(section.title)),
          section.fields.map((field) => h(Row, {
            key: field.key,
            t,
            field,
            value: value[field.key],
            write,
          })),
        )),
      )
    }

    return {
      inject: ['slots', 'locale', 'configForms'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, COPY), 'bark-notify: settings dictionaries')
        const t = ctx.locale.bind(NS)
        const configForms = ctx.configForms
        const register = () => ctx.slots.register({
          name: 'settings.plugins.tab',
          id: 'bark-notify',
          order: 70,
          label: () => t('tab'),
          locale: NS,
          inject: () => ({ configForms, t }),
        }, Panel)
        ctx.slots.inject('settings.plugins.tab', register)
      },
    }
  },
})
