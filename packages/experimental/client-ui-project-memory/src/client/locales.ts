/** Locale bundles for the Project memory settings page. */

import type { SettingsFormLabels } from '@deepseek-ai/dsh-client-ui-primitives'

/** Locale keys the page renders. */
export type ProjectMemorySettingsLocaleKey =
  | 'title' | 'description'
  | 'maxEntries' | 'maxEntriesHint'
  | 'maxEntryChars' | 'maxEntryCharsHint'
  | 'overridden' | 'reset' | 'readOnly' | 'unavailable'
  | 'save' | 'saving' | 'saveFailed' | 'invalidNumber'

/** English copy. */
export const en: Record<ProjectMemorySettingsLocaleKey, string> = {
  title: 'Project memory',
  description: 'Control how much shared memory a Project keeps.',
  maxEntries: 'Entries per Project',
  maxEntriesHint: 'How many entries one Project keeps before a new one is refused. Remove or merge outdated entries to make room.',
  maxEntryChars: 'Characters per entry',
  maxEntryCharsHint: 'Longest entry text, counted in characters. A longer limit lets one entry hold a whole decision; a shorter one keeps entries scannable.',
  overridden: 'Overridden',
  reset: 'Reset to default',
  readOnly: 'This deployment stores settings read-only.',
  unavailable: 'Project memory is not loaded, so it cannot be configured right now.',
  save: 'Save',
  saving: 'Saving…',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
  invalidNumber: 'Enter a whole number, or leave blank to use the default.',
}

/** Simplified Chinese copy. */
export const zh: Record<ProjectMemorySettingsLocaleKey, string> = {
  title: 'Project 记忆',
  description: '控制每个 Project 保存多少共享记忆。',
  maxEntries: '每个 Project 的条目数',
  maxEntriesHint: '单个 Project 最多保留多少条记忆，超过后新的写入会被拒绝。删除或合并过期条目即可腾出空间。',
  maxEntryChars: '每条记忆的字符数',
  maxEntryCharsHint: '条目文本的最大长度，按字符计。更长的上限允许一条记忆写下完整决定；更短的上限让条目更易扫读。',
  overridden: '已覆盖',
  reset: '恢复默认',
  readOnly: '本部署的设置为只读。',
  unavailable: 'Project 记忆当前未加载，暂时无法配置。',
  save: '保存',
  saving: '保存中…',
  saveFailed: '本部署没有接受这些值，已保留供你修改。',
  invalidNumber: '请填整数；留空表示使用默认值。',
}

/**
 * The form frame's copy, read from this page's dictionary.
 * @param t - the page's locale reader.
 * @returns the labels the shared settings form renders.
 */
export function formLabels(t: (key: ProjectMemorySettingsLocaleKey) => string): SettingsFormLabels {
  return { unavailable: t('unavailable'), readOnly: t('readOnly'), saveFailed: t('saveFailed'), save: t('save'), saving: t('saving') }
}

/** Japanese copy. */
export const ja: Record<ProjectMemorySettingsLocaleKey, string> = {
  title: 'プロジェクトメモリ',
  description: 'プロジェクトが保持する共有メモリの量を制御します。',
  maxEntries: 'プロジェクトあたりのエントリ数',
  maxEntriesHint: '1つのプロジェクトが保持できるエントリの上限です。超過すると新しいエントリは拒否されます。古いエントリを削除または統合して空きを作ってください。',
  maxEntryChars: 'エントリあたりの文字数',
  maxEntryCharsHint: 'エントリテキストの最大長（文字数）。上限を長くすると1つのエントリに決定内容全体を書け、短くすると流し読みしやすくなります。',
  overridden: 'オーバーライド済み',
  reset: 'デフォルトに戻す',
  readOnly: 'このデプロイの設定は読み取り専用です。',
  unavailable: 'プロジェクトメモリが読み込まれていないため、今は設定できません。',
  save: '保存',
  saving: '保存中…',
  saveFailed: 'デプロイがこれらの値を受け入れなかったため、修正できるようにそのまま残してあります。',
  invalidNumber: '整数を入力するか、デフォルト値を使う場合は空欄のままにしてください。',
}

/** Spanish copy. */
export const es: Record<ProjectMemorySettingsLocaleKey, string> = {
  title: 'Memoria del proyecto',
  description: 'Controla cuánta memoria compartida conserva un proyecto.',
  maxEntries: 'Entradas por proyecto',
  maxEntriesHint: 'Cuántas entradas conserva un proyecto antes de rechazar una nueva. Elimina o combina entradas obsoletas para hacer espacio.',
  maxEntryChars: 'Caracteres por entrada',
  maxEntryCharsHint: 'Longitud máxima del texto de una entrada, en caracteres. Un límite mayor permite que una entrada contenga una decisión completa; uno menor mantiene las entradas fáciles de leer.',
  overridden: 'Sobrescrito',
  reset: 'Restablecer valor predeterminado',
  readOnly: 'Esta implementación almacena la configuración en modo de solo lectura.',
  unavailable: 'La memoria del proyecto no está cargada, así que no se puede configurar ahora.',
  save: 'Guardar',
  saving: 'Guardando…',
  saveFailed: 'La implementación no aceptó estos valores; se conservaron para que los corrijas.',
  invalidNumber: 'Escribe un número entero, o deja en blanco para usar el valor predeterminado.',
}

/** French copy. */
export const fr: Record<ProjectMemorySettingsLocaleKey, string> = {
  title: 'Mémoire du projet',
  description: 'Contrôle la quantité de mémoire partagée conservée par un projet.',
  maxEntries: 'Entrées par projet',
  maxEntriesHint: "Nombre d'entrées qu'un projet conserve avant d'en refuser une nouvelle. Supprimez ou fusionnez les entrées obsolètes pour faire de la place.",
  maxEntryChars: 'Caractères par entrée',
  maxEntryCharsHint: "Longueur maximale du texte d'une entrée, en caractères. Une limite plus grande permet à une entrée de contenir une décision entière ; une plus petite garde les entrées lisibles en diagonale.",
  overridden: 'Redéfini',
  reset: 'Rétablir la valeur par défaut',
  readOnly: 'Cette instance stocke les paramètres en lecture seule.',
  unavailable: "La mémoire du projet n'est pas chargée ; elle ne peut pas être configurée pour l'instant.",
  save: 'Enregistrer',
  saving: 'Enregistrement…',
  saveFailed: "L'instance n'a pas accepté ces valeurs ; elles ont été conservées pour que vous les corrigiez.",
  invalidNumber: 'Saisissez un nombre entier, ou laissez vide pour utiliser la valeur par défaut.',
}

/** German copy. */
export const de: Record<ProjectMemorySettingsLocaleKey, string> = {
  title: 'Projektgedächtnis',
  description: 'Steuert, wie viel gemeinsames Gedächtnis ein Projekt behält.',
  maxEntries: 'Einträge pro Projekt',
  maxEntriesHint: 'Wie viele Einträge ein Projekt behält, bevor ein neuer abgelehnt wird. Entferne oder führe veraltete Einträge zusammen, um Platz zu schaffen.',
  maxEntryChars: 'Zeichen pro Eintrag',
  maxEntryCharsHint: 'Längster Eintragstext, in Zeichen gezählt. Ein höheres Limit erlaubt einem Eintrag eine ganze Entscheidung; ein niedrigeres hält Einträge übersichtlich.',
  overridden: 'Überschrieben',
  reset: 'Auf Standard zurücksetzen',
  readOnly: 'Diese Bereitstellung speichert Einstellungen schreibgeschützt.',
  unavailable: 'Projektgedächtnis ist nicht geladen und kann derzeit nicht konfiguriert werden.',
  save: 'Speichern',
  saving: 'Speichern…',
  saveFailed: 'Die Bereitstellung hat diese Werte nicht übernommen; sie wurden zur Korrektur beibehalten.',
  invalidNumber: 'Gib eine ganze Zahl ein oder lasse das Feld leer, um den Standardwert zu verwenden.',
}

/** Russian copy. */
export const ru: Record<ProjectMemorySettingsLocaleKey, string> = {
  title: 'Память проекта',
  description: 'Управляет объёмом общей памяти, которую хранит проект.',
  maxEntries: 'Записей на проект',
  maxEntriesHint: 'Сколько записей хранит один проект, после чего новые отклоняются. Удаляйте или объединяйте устаревшие записи, чтобы освободить место.',
  maxEntryChars: 'Символов на запись',
  maxEntryCharsHint: 'Наибольшая длина текста записи в символах. Больший лимит позволяет записать целое решение в одну запись; меньший сохраняет записи удобными для просмотра.',
  overridden: 'Переопределено',
  reset: 'Сбросить к значению по умолчанию',
  readOnly: 'Эта установка хранит настройки в режиме только для чтения.',
  unavailable: 'Память проекта не загружена, поэтому сейчас её нельзя настроить.',
  save: 'Сохранить',
  saving: 'Сохранение…',
  saveFailed: 'Установка не приняла эти значения; они оставлены для исправления.',
  invalidNumber: 'Введите целое число или оставьте пустым, чтобы использовать значение по умолчанию.',
}

/** Portuguese copy. */
export const pt: Record<ProjectMemorySettingsLocaleKey, string> = {
  title: 'Memória do projeto',
  description: 'Controla quanta memória compartilhada um projeto mantém.',
  maxEntries: 'Entradas por projeto',
  maxEntriesHint: 'Quantas entradas um projeto mantém antes de recusar uma nova. Remova ou mescle entradas desatualizadas para liberar espaço.',
  maxEntryChars: 'Caracteres por entrada',
  maxEntryCharsHint: 'Comprimento máximo do texto de uma entrada, em caracteres. Um limite maior permite que uma entrada contenha uma decisão inteira; um menor mantém as entradas fáceis de ler.',
  overridden: 'Substituído',
  reset: 'Restaurar padrão',
  readOnly: 'Esta implantação armazena as configurações somente para leitura.',
  unavailable: 'A memória do projeto não está carregada, portanto não pode ser configurada agora.',
  save: 'Salvar',
  saving: 'Salvando…',
  saveFailed: 'A implantação não aceitou esses valores; eles foram mantidos para você corrigir.',
  invalidNumber: 'Digite um número inteiro ou deixe em branco para usar o padrão.',
}
