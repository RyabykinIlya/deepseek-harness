/**
 * Copy for the model-routing surfaces: the composer chip, the settings page, and
 * the Thread roster entry.
 *
 * Tier labels are addressed by name rather than enumerated, because tiers are
 * configured: `pro` and `flash` are the two the plan ships, and a deployment
 * that adds a third gets its raw name rendered rather than a missing key.
 */

import type { LocaleDictOf } from '@deepseek-ai/dsh-client-ui-slots'

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.modelRouting'

/** Every key of this namespace's dictionaries. */
export type ModelRoutingLocaleKey =
  | 'title'
  | 'summary'
  | 'chip.unpinned'
  | 'chip.pending'
  | 'boundary.start'
  | 'boundary.selection-change'
  | 'boundary.compaction'
  | 'boundary.idle'
  | 'boundary.failure'
  | 'tier.pro'
  | 'tier.flash'
  | 'routeSettings'
  | 'tierTabsLabel'
  | 'tierName'
  | 'tierLabel'
  | 'tierModels'
  | 'tierFilter'
  | 'tierContextWindow'
  | 'tierMaxTokens'
  | 'tierMinQuantization'
  | 'tierUnknownQuantization'
  | 'tierFree'
  | 'free.off'
  | 'free.prefer'
  | 'free.only'
  | 'unknown.reject'
  | 'unknown.trusted'
  | 'unknown.accept'
  | 'trustedUnknownProviders'
  | 'judgeEnabled'
  | 'defaultTier'
  | 'cacheIdleMinutes'
  | 'freeForSubagents'
  | 'freeForSoloSessions'
  | 'freeUsage'
  | 'free.unknown'
  | 'quote.perMillion'
  | 'quote.unavailable'
  | 'save'
  | 'discard'
  | 'unsaved'
  | 'conflict'
  | 'failed'
  | 'saving'
  | 'empty'
  | 'threadModel'
  | 'switch.title'
  | 'chip.fallback'
  | 'chip.fallbackHint'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Model routing chip and settings page copy. */
    'settings.modelRouting': ModelRoutingLocaleKey
  }
}

/** English copy. */
export const en: LocaleDictOf<typeof NS> = {
  title: 'Model routing',
  summary: '{tiers} tiers, {models} models',
  'chip.unpinned': 'no provider pinned',
  'chip.pending': 'next request: {model}',
  'boundary.start': 'session start',
  'boundary.selection-change': 'model changed',
  'boundary.compaction': 'after compaction',
  'boundary.idle': 'after idle',
  'boundary.failure': 'after a provider failure',
  'tier.pro': 'pro',
  'tier.flash': 'flash',
  routeSettings: 'Route',
  tierTabsLabel: 'Tier',
  tierName: 'Tier name',
  tierLabel: 'Tier label',
  tierModels: 'Models',
  tierFilter: 'Filter models',
  tierContextWindow: 'Context window',
  tierMaxTokens: 'Output tokens',
  tierMinQuantization: 'Minimum quantization',
  tierUnknownQuantization: 'Unknown quantization',
  tierFree: 'Free endpoints',
  'free.off': 'do not use',
  'free.prefer': 'prefer',
  'free.only': 'only',
  'unknown.reject': 'reject',
  'unknown.trusted': 'trust listed providers',
  'unknown.accept': 'accept',
  trustedUnknownProviders: 'Trusted unknown-quantization providers',
  judgeEnabled: 'Choose the tier automatically',
  defaultTier: 'Default tier',
  cacheIdleMinutes: 'Re-decide after idle (minutes)',
  freeForSubagents: 'Allow free endpoints in subagents',
  freeForSoloSessions: 'Allow free endpoints in solo sessions',
  freeUsage: 'Free requests today: {used} of {limit}',
  'free.unknown': 'Free requests today: unknown',
  'quote.perMillion': '{tag} · {quantization} · ${price}/M',
  'quote.unavailable': 'price unavailable',
  save: 'Save',
  discard: 'Discard',
  unsaved: 'Unsaved changes',
  conflict: 'These settings changed elsewhere. Discard and re-enter them.',
  failed: 'The settings could not be saved.',
  saving: 'Saving…',
  empty: 'No tier is configured, so this page has nothing to edit.',
  threadModel: 'model',
  'switch.title': 'Model switched',
  'chip.fallback': 'OpenRouter fallback',
  'chip.fallbackHint': 'When the subscription runs out of quota, continue on OpenRouter. Off: the turn fails and the next message tries the subscription again.',
}

/** Chinese copy. */
export const zh: LocaleDictOf<typeof NS> = {
  title: '模型路由',
  summary: '{tiers} 个层级，{models} 个模型',
  'chip.unpinned': '未固定服务商',
  'chip.pending': '下一个请求：{model}',
  'boundary.start': '会话开始',
  'boundary.selection-change': '模型已更改',
  'boundary.compaction': '压缩之后',
  'boundary.idle': '空闲之后',
  'boundary.failure': '服务商失败之后',
  'tier.pro': 'pro',
  'tier.flash': 'flash',
  routeSettings: '路由',
  tierTabsLabel: '层级',
  tierName: '层级名称',
  tierLabel: '层级标签',
  tierModels: '模型',
  tierFilter: '筛选模型',
  tierContextWindow: '上下文窗口',
  tierMaxTokens: '输出令牌',
  tierMinQuantization: '最低量化精度',
  tierUnknownQuantization: '未知量化精度',
  tierFree: '免费端点',
  'free.off': '不使用',
  'free.prefer': '优先',
  'free.only': '仅使用',
  'unknown.reject': '拒绝',
  'unknown.trusted': '信任列出的服务商',
  'unknown.accept': '接受',
  trustedUnknownProviders: '信任的未知量化服务商',
  judgeEnabled: '自动选择层级',
  defaultTier: '默认层级',
  cacheIdleMinutes: '空闲后重新决策（分钟）',
  freeForSubagents: '允许子代理使用免费端点',
  freeForSoloSessions: '允许独立会话使用免费端点',
  freeUsage: '今日免费请求：{used} / {limit}',
  'free.unknown': '今日免费请求：未知',
  'quote.perMillion': '{tag} · {quantization} · ${price}/M',
  'quote.unavailable': '价格不可用',
  save: '保存',
  discard: '放弃',
  unsaved: '未保存的更改',
  conflict: '这些设置已被其他更改修改。请放弃后重新填写。',
  failed: '设置未能保存。',
  saving: '保存中…',
  empty: '未配置层级，此页面没有可编辑的内容。',
  threadModel: '模型',
  'switch.title': '模型已切换',
  'chip.fallback': 'OpenRouter 接管',
  'chip.fallbackHint': '订阅额度用尽后改用 OpenRouter 继续。关闭时：本轮失败，下一条消息再次尝试订阅。',
}

/** Japanese copy. */
export const ja: LocaleDictOf<typeof NS> = {
  title: 'モデルルーティング',
  summary: '{tiers} ティア、{models} モデル',
  'chip.unpinned': 'プロバイダー未固定',
  'chip.pending': '次のリクエスト: {model}',
  'boundary.start': 'セッション開始',
  'boundary.selection-change': 'モデル変更',
  'boundary.compaction': '圧縮後',
  'boundary.idle': 'アイドル後',
  'boundary.failure': 'プロバイダー障害後',
  'tier.pro': 'pro',
  'tier.flash': 'flash',
  routeSettings: 'ルート',
  tierTabsLabel: 'ティア',
  tierName: 'ティア名',
  tierLabel: 'ティアラベル',
  tierModels: 'モデル',
  tierFilter: 'モデルを絞り込む',
  tierContextWindow: 'コンテキストウィンドウ',
  tierMaxTokens: '出力トークン',
  tierMinQuantization: '最低量子化',
  tierUnknownQuantization: '未知の量子化',
  tierFree: '無料エンドポイント',
  'free.off': '使わない',
  'free.prefer': '優先',
  'free.only': 'のみ',
  'unknown.reject': '拒否',
  'unknown.trusted': '列挙したプロバイダーを信頼',
  'unknown.accept': '受け入れる',
  trustedUnknownProviders: '信頼する未知の量子化プロバイダー',
  judgeEnabled: 'ティアを自動選択',
  defaultTier: '既定のティア',
  cacheIdleMinutes: 'アイドル後に再判定（分）',
  freeForSubagents: 'サブエージェントで無料エンドポイントを許可',
  freeForSoloSessions: '単独セッションで無料エンドポイントを許可',
  freeUsage: '今日の無料リクエスト: {used} / {limit}',
  'free.unknown': '今日の無料リクエスト: 不明',
  'quote.perMillion': '{tag} · {quantization} · ${price}/M',
  'quote.unavailable': '価格情報なし',
  save: '保存',
  discard: '破棄',
  unsaved: '未保存の変更',
  conflict: 'これらの設定は他で変更されました。破棄して入力し直してください。',
  failed: '設定を保存できませんでした。',
  saving: '保存中…',
  empty: 'ティアが設定されていないため、編集する内容がありません。',
  threadModel: 'モデル',
  'switch.title': 'モデルを切り替えました',
  'chip.fallback': 'OpenRouter フォールバック',
  'chip.fallbackHint': 'サブスクリプションの残量を使い切ったら OpenRouter で継続します。オフのとき: そのターンは失敗し、次のメッセージで再度サブスクリプションを試します。',
}

/** Spanish copy. */
export const es: LocaleDictOf<typeof NS> = {
  title: 'Enrutamiento de modelos',
  summary: '{tiers} niveles, {models} modelos',
  'chip.unpinned': 'sin proveedor fijado',
  'chip.pending': 'siguiente petición: {model}',
  'boundary.start': 'inicio de sesión',
  'boundary.selection-change': 'modelo cambiado',
  'boundary.compaction': 'tras la compactación',
  'boundary.idle': 'tras inactividad',
  'boundary.failure': 'tras un fallo del proveedor',
  'tier.pro': 'pro',
  'tier.flash': 'flash',
  routeSettings: 'Ruta',
  tierTabsLabel: 'Nivel',
  tierName: 'Nombre del nivel',
  tierLabel: 'Etiqueta del nivel',
  tierModels: 'Modelos',
  tierFilter: 'Filtrar modelos',
  tierContextWindow: 'Ventana de contexto',
  tierMaxTokens: 'Tokens de salida',
  tierMinQuantization: 'Cuantización mínima',
  tierUnknownQuantization: 'Cuantización desconocida',
  tierFree: 'Endpoints gratuitos',
  'free.off': 'no usar',
  'free.prefer': 'preferir',
  'free.only': 'solo',
  'unknown.reject': 'rechazar',
  'unknown.trusted': 'confiar en los proveedores listados',
  'unknown.accept': 'aceptar',
  trustedUnknownProviders: 'Proveedores de cuantización desconocida de confianza',
  judgeEnabled: 'Elegir el nivel automáticamente',
  defaultTier: 'Nivel predeterminado',
  cacheIdleMinutes: 'Redecidir tras inactividad (minutos)',
  freeForSubagents: 'Permitir endpoints gratuitos en subagentes',
  freeForSoloSessions: 'Permitir endpoints gratuitos en sesiones en solitario',
  freeUsage: 'Peticiones gratuitas hoy: {used} de {limit}',
  'free.unknown': 'Peticiones gratuitas hoy: desconocido',
  'quote.perMillion': '{tag} · {quantization} · ${price}/M',
  'quote.unavailable': 'precio no disponible',
  save: 'Guardar',
  discard: 'Descartar',
  unsaved: 'Cambios sin guardar',
  conflict: 'Estos ajustes cambiaron en otro lugar. Descártalos e introdúcelos de nuevo.',
  failed: 'No se pudo guardar la configuración.',
  saving: 'Guardando…',
  empty: 'No hay ningún nivel configurado, así que esta página no tiene nada que editar.',
  threadModel: 'modelo',
  'switch.title': 'Modelo cambiado',
  'chip.fallback': 'Reserva de OpenRouter',
  'chip.fallbackHint': 'Cuando la suscripción se agote, continúa con OpenRouter. Desactivado: el turno falla y el siguiente mensaje vuelve a intentar la suscripción.',
}

/** French copy. */
export const fr: LocaleDictOf<typeof NS> = {
  title: 'Routage des modèles',
  summary: '{tiers} paliers, {models} modèles',
  'chip.unpinned': 'aucun fournisseur épinglé',
  'chip.pending': 'prochaine requête : {model}',
  'boundary.start': 'début de session',
  'boundary.selection-change': 'modèle changé',
  'boundary.compaction': 'après compactage',
  'boundary.idle': 'après inactivité',
  'boundary.failure': 'après un échec de fournisseur',
  'tier.pro': 'pro',
  'tier.flash': 'flash',
  routeSettings: 'Route',
  tierTabsLabel: 'Palier',
  tierName: 'Nom du palier',
  tierLabel: 'Libellé du palier',
  tierModels: 'Modèles',
  tierFilter: 'Filtrer les modèles',
  tierContextWindow: 'Fenêtre de contexte',
  tierMaxTokens: 'Jetons de sortie',
  tierMinQuantization: 'Quantification minimale',
  tierUnknownQuantization: 'Quantification inconnue',
  tierFree: 'Endpoints gratuits',
  'free.off': 'ne pas utiliser',
  'free.prefer': 'en priorité',
  'free.only': 'uniquement',
  'unknown.reject': 'refuser',
  'unknown.trusted': 'faire confiance aux fournisseurs listés',
  'unknown.accept': 'accepter',
  trustedUnknownProviders: 'Fournisseurs de quantification inconnue de confiance',
  judgeEnabled: "Choisir le palier automatiquement",
  defaultTier: 'Palier par défaut',
  cacheIdleMinutes: 'Redécider après inactivité (minutes)',
  freeForSubagents: 'Autoriser les endpoints gratuits dans les sous-agents',
  freeForSoloSessions: 'Autoriser les endpoints gratuits dans les sessions solo',
  freeUsage: 'Requêtes gratuites aujourd\u2019hui : {used} sur {limit}',
  'free.unknown': 'Requêtes gratuites aujourd\u2019hui : inconnu',
  'quote.perMillion': '{tag} · {quantization} · ${price}/M',
  'quote.unavailable': 'prix indisponible',
  save: 'Enregistrer',
  discard: 'Abandonner',
  unsaved: 'Modifications non enregistrées',
  conflict: 'Ces paramètres ont été modifiés ailleurs. Abandonnez et ressaisissez-les.',
  failed: "Les paramètres n'ont pas pu être enregistrés.",
  saving: 'Enregistrement…',
  empty: "Aucun palier n'est configuré ; cette page n'a rien à modifier.",
  threadModel: 'modèle',
  'switch.title': 'Modèle changé',
  'chip.fallback': 'Repli OpenRouter',
  'chip.fallbackHint': "Quand le quota de l'abonnement est épuisé, continue sur OpenRouter. Désactivé : le tour échoue et le prochain message réessaie l'abonnement.",
}

/** German copy. */
export const de: LocaleDictOf<typeof NS> = {
  title: 'Modellrouting',
  summary: '{tiers} Stufen, {models} Modelle',
  'chip.unpinned': 'kein Anbieter festgelegt',
  'chip.pending': 'nächste Anfrage: {model}',
  'boundary.start': 'Sitzungsstart',
  'boundary.selection-change': 'Modell geändert',
  'boundary.compaction': 'nach Kompaktierung',
  'boundary.idle': 'nach Leerlauf',
  'boundary.failure': 'nach Anbieterfehler',
  'tier.pro': 'pro',
  'tier.flash': 'flash',
  routeSettings: 'Route',
  tierTabsLabel: 'Stufe',
  tierName: 'Stufenname',
  tierLabel: 'Stufenbezeichnung',
  tierModels: 'Modelle',
  tierFilter: 'Modelle filtern',
  tierContextWindow: 'Kontextfenster',
  tierMaxTokens: 'Ausgabe-Tokens',
  tierMinQuantization: 'Minimale Quantisierung',
  tierUnknownQuantization: 'Unbekannte Quantisierung',
  tierFree: 'Kostenlose Endpunkte',
  'free.off': 'nicht verwenden',
  'free.prefer': 'bevorzugen',
  'free.only': 'ausschließlich',
  'unknown.reject': 'ablehnen',
  'unknown.trusted': 'gelisteten Anbietern vertrauen',
  'unknown.accept': 'akzeptieren',
  trustedUnknownProviders: 'Vertrauenswürdige Anbieter unbekannter Quantisierung',
  judgeEnabled: 'Stufe automatisch wählen',
  defaultTier: 'Standardstufe',
  cacheIdleMinutes: 'Nach Leerlauf neu entscheiden (Minuten)',
  freeForSubagents: 'Kostenlose Endpunkte in Subagenten erlauben',
  freeForSoloSessions: 'Kostenlose Endpunkte in Einzelsitzungen erlauben',
  freeUsage: 'Kostenlose Anfragen heute: {used} von {limit}',
  'free.unknown': 'Kostenlose Anfragen heute: unbekannt',
  'quote.perMillion': '{tag} · {quantization} · ${price}/M',
  'quote.unavailable': 'Preis nicht verfügbar',
  save: 'Speichern',
  discard: 'Verwerfen',
  unsaved: 'Ungespeicherte Änderungen',
  conflict: 'Diese Einstellungen wurden anderweitig geändert. Verwerfe sie und gib sie erneut ein.',
  failed: 'Die Einstellungen konnten nicht gespeichert werden.',
  saving: 'Speichern…',
  empty: 'Keine Stufe konfiguriert; diese Seite hat nichts zu bearbeiten.',
  threadModel: 'Modell',
  'switch.title': 'Modell gewechselt',
  'chip.fallback': 'OpenRouter-Fallback',
  'chip.fallbackHint': 'Wenn das Abonnement aufgebraucht ist, mit OpenRouter weitermachen. Aus: der Zug schlägt fehl und die nächste Nachricht versucht das Abonnement erneut.',
}

/** Russian copy. */
export const ru: LocaleDictOf<typeof NS> = {
  title: 'Маршрутизация моделей',
  summary: '{tiers} уровней, {models} моделей',
  'chip.unpinned': 'провайдер не закреплён',
  'chip.pending': 'следующий запрос: {model}',
  'boundary.start': 'начало сессии',
  'boundary.selection-change': 'модель изменена',
  'boundary.compaction': 'после сжатия',
  'boundary.idle': 'после простоя',
  'boundary.failure': 'после сбоя провайдера',
  'tier.pro': 'pro',
  'tier.flash': 'flash',
  routeSettings: 'Маршрут',
  tierTabsLabel: 'Уровень',
  tierName: 'Название уровня',
  tierLabel: 'Подпись уровня',
  tierModels: 'Модели',
  tierFilter: 'Фильтровать модели',
  tierContextWindow: 'Окно контекста',
  tierMaxTokens: 'Токены вывода',
  tierMinQuantization: 'Минимальная квантизация',
  tierUnknownQuantization: 'Неизвестная квантизация',
  tierFree: 'Бесплатные эндпоинты',
  'free.off': 'не использовать',
  'free.prefer': 'предпочитать',
  'free.only': 'только',
  'unknown.reject': 'отклонять',
  'unknown.trusted': 'доверять перечисленным провайдерам',
  'unknown.accept': 'принимать',
  trustedUnknownProviders: 'Доверенные провайдеры с неизвестной квантизацией',
  judgeEnabled: 'Выбирать уровень автоматически',
  defaultTier: 'Уровень по умолчанию',
  cacheIdleMinutes: 'Пересматривать после простоя (минут)',
  freeForSubagents: 'Разрешить бесплатные эндпоинты в субагентах',
  freeForSoloSessions: 'Разрешить бесплатные эндпоинты в одиночных сессиях',
  freeUsage: 'Бесплатных запросов сегодня: {used} из {limit}',
  'free.unknown': 'Бесплатных запросов сегодня: неизвестно',
  'quote.perMillion': '{tag} · {quantization} · ${price}/M',
  'quote.unavailable': 'цена недоступна',
  save: 'Сохранить',
  discard: 'Отменить',
  unsaved: 'Несохранённые изменения',
  conflict: 'Эти настройки изменены в другом месте. Отмените и введите заново.',
  failed: 'Не удалось сохранить настройки.',
  saving: 'Сохранение…',
  empty: 'Ни один уровень не настроен, поэтому на странице нечего редактировать.',
  threadModel: 'модель',
  'switch.title': 'Модель переключена',
  'chip.fallback': 'Резерв OpenRouter',
  'chip.fallbackHint': 'Когда квота подписки исчерпана, продолжить на OpenRouter. Выключено: ход завершается ошибкой, следующее сообщение снова пробует подписку.',
}

/** Portuguese copy. */
export const pt: LocaleDictOf<typeof NS> = {
  title: 'Roteamento de modelos',
  summary: '{tiers} níveis, {models} modelos',
  'chip.unpinned': 'nenhum provedor fixado',
  'chip.pending': 'próxima solicitação: {model}',
  'boundary.start': 'início da sessão',
  'boundary.selection-change': 'modelo alterado',
  'boundary.compaction': 'após a compactação',
  'boundary.idle': 'após inatividade',
  'boundary.failure': 'após falha de provedor',
  'tier.pro': 'pro',
  'tier.flash': 'flash',
  routeSettings: 'Rota',
  tierTabsLabel: 'Nível',
  tierName: 'Nome do nível',
  tierLabel: 'Rótulo do nível',
  tierModels: 'Modelos',
  tierFilter: 'Filtrar modelos',
  tierContextWindow: 'Janela de contexto',
  tierMaxTokens: 'Tokens de saída',
  tierMinQuantization: 'Quantização mínima',
  tierUnknownQuantization: 'Quantização desconhecida',
  tierFree: 'Endpoints gratuitos',
  'free.off': 'não usar',
  'free.prefer': 'preferir',
  'free.only': 'somente',
  'unknown.reject': 'rejeitar',
  'unknown.trusted': 'confiar nos provedores listados',
  'unknown.accept': 'aceitar',
  trustedUnknownProviders: 'Provedores de quantização desconhecida confiáveis',
  judgeEnabled: 'Escolher o nível automaticamente',
  defaultTier: 'Nível padrão',
  cacheIdleMinutes: 'Reavaliar após inatividade (minutos)',
  freeForSubagents: 'Permitir endpoints gratuitos em subagentes',
  freeForSoloSessions: 'Permitir endpoints gratuitos em sessões solo',
  freeUsage: 'Solicitações gratuitas hoje: {used} de {limit}',
  'free.unknown': 'Solicitações gratuitas hoje: desconhecido',
  'quote.perMillion': '{tag} · {quantization} · ${price}/M',
  'quote.unavailable': 'preço indisponível',
  save: 'Salvar',
  discard: 'Descartar',
  unsaved: 'Alterações não salvas',
  conflict: 'Essas configurações foram alteradas em outro lugar. Descarte e insira novamente.',
  failed: 'Não foi possível salvar as configurações.',
  saving: 'Salvando…',
  empty: 'Nenhum nível configurado, então esta página não tem nada para editar.',
  threadModel: 'modelo',
  'switch.title': 'Modelo alterado',
  'chip.fallback': 'Reserva do OpenRouter',
  'chip.fallbackHint': 'Quando a cota da assinatura acabar, continue no OpenRouter. Desligado: o turno falha e a próxima mensagem tenta a assinatura novamente.',
}
