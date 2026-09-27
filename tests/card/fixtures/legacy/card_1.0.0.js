// Build marker. Since 1.0.0 the card ships inside the ig_doorbell integration and its version IS
// the integration's (manifest.json): one product, one number. The integration serves this file
// with `?v=<hash of the file>` (card.py), so a browser never keeps running an old copy after an
// update - the problem this log line was added for on 2026-07-12, when the card was a separate
// install behind a manual Lovelace resource with a bare URL, and a fixed file on disk and the copy
// the browser kept could diverge with no visible error.
// The line still earns its place: it ALWAYS runs when the module loads, even before any card
// instance exists, so DevTools settles "which build is this browser running?" in one look.
const CARD_VERSION = '1.0.0';
const CARD_BUILD_ID = `${CARD_VERSION} 2026-09-26-ig-doorbell`;

// The names the card shares with Home Assistant live HERE and only here. The domain is the
// integration's (WS commands, services, proxy routes, device identifiers, entity platform,
// media_source).
const IG_DOMAIN = 'ig_doorbell';
const CARD_TAG = 'ig-doorbell-card';
const VIEW_TAG = 'ig-doorbell-view';
const EDITOR_TAG = 'ig-doorbell-card-editor';

// ⚠️ THIS MARKER LIVES IN THE MODULE, NOT THE ELEMENT, AND THAT'S THE WHOLE POINT (2026-09-07).
//
// The idle countdown no longer restarted on every stream reconnection (v1.5.1), and it was
// still not firing on the wallpanel. The HASS session measured it: with
// `idle_release_seconds: 60`, at 80 s the wake locks were still being held.
//
// Their hypothesis, and it was the right one: **if Home Assistant destroys and recreates the
// card element on reconnection, the new instance starts its own count from zero.** All the state
// lived in `this`, so the earlier fix covered "rearm the same timer" and did NOT cover "new
// instance with a new timer." With reconnections every 30-45 s, a 60 s deadline never arrives.
//
// The fix isn't to persist the timer, it's to **change what the deadline means**: from
// relative ("60 s since I armed it") to absolute ("60 s since the last touch"). With a reference
// instant that survives the element, rearming and recreating both stop mattering --
// and a new instance born when 60 s have already passed lets go IMMEDIATELY, instead of
// handing out another free minute.
let LAST_INTERACTION_MS = Date.now();

// ⚠️ THE IDLE PAUSE LIVES IN THE MODULE, PER DOORBELL (1.9.1, measured on the living-room tablet
// on 2026-09-25). Home Assistant re-inserts -- or recreates -- the card element without
// anyone touching it; with the pause stored in `this`, every re-insertion opened a new session that
// got paused again a few seconds later: the doorbell's slot kept entering and leaving in a loop (seen
// in /api/debug/cores on Ermita 10: sessions 0 -> 1 -> 2 -> 1 every ~20 s with the tablet untouched).
// An idle pause can only be lifted by a person (touch) or a doorbell ring; never a
// connectedCallback. It's lost on a full reload, which is correct: reloading means starting over.
const PAUSED_BY_DOORBELL = {};

// ⚠️ REENTRANCY-GUARD FUSE FOR startWebRTC() -- see that function for the full argument.
//
// A guard that just said "one's already in flight, I won't start another" and nothing else would be
// WORSE than the bug it fixes: a startup that gets stuck forever (a TURN credentials `fetch`
// against Germany and a `new WebSocket()` against the relay have NO deadline of their own; a stuck
// TCP socket can go minutes without resolving or failing) would leave the card black with no way
// back, and on a wallpanel that's indistinguishable from a broken card.
//
// That's why the guard EXPIRES. 12 s is deliberately awkward between the two scales that matter:
// well above any healthy startup (get_connection_info over HA's WebSocket, sub-
// second; TURN credentials, ~1 s; local path, its own 3 s cap; opening the relay's WS,
// another couple of seconds) and well below how long a stuck socket takes to give up. What it
// buys: past 12 s, ANY later trigger takes over from the stuck one instead of
// respecting it.
const START_IN_FLIGHT_MAX_MS = 12000;

// ⚠️ THE IDLE PAUSE IS THE SAME ONE THE APPS USE, NOT A NEW ONE (2026-09-25, §1.4-bis "Live pause").
// When the deadline expires the card does what an app does when it goes to the background:
// `live_pause` right away (the doorbell stops encrypting and sending video, the session stays alive)
// and, if nobody comes back within IDLE_GRACE_MS, `bye` -- the slot is actually released. The 15 s
// match the apps' (SessionBackgroundRule.idleGrace). Coming back within the grace period is
// `live_resume` (video in < 1 s), with the contract's bounded rescue (rule 3): `live_resume` again
// at 6 s and 12 s, a new session at 24 s, and nothing beyond that. Coming back later is a new session.
const IDLE_GRACE_MS = 15000;
// Off-screen WITH a call doesn't hang up during the grace period (the session is the call), but it
// doesn't go on forever either: 300 s is the doorbell's own safety net for a call with no turn
// (§1.4-quater rule 2), and past that there's no call left to preserve.
const CALL_HIDDEN_MAX_MS = 300000;
const OFFSCREEN_PAUSE_MS = 1500;
// Maximum pinch-zoom (1.9.3). x5 on the doorbell's image already shows the sensor's
// individual pixels; beyond that it just magnifies the blur.
const ZOOM_MAX = 5;
const RECENT_RING_MS = 60000;
// Decorative "Door open · Closing in N s" countdown (formerly the `unlock_duration` option).
const DOOR_OPEN_DISPLAY_S = 3;
const LIVE_ACK_MS = 3000;          // rule 1: if there's no live_state within 3 s, resend...
const LIVE_ACK_RETRIES = 3;     // ...up to 3 times
const RESCUE_RESUME_MS = [6000, 12000];
const RESCUE_NEW_SESSION_MS = 24000;

console.log(`[ig-doorbell-card] module loaded - build=${CARD_BUILD_ID} (compare this value against CARD_BUILD_ID in the repo if you're unsure whether the browser is serving a stale cached copy)`);

// Global translation dictionary for Card and Editor (Top 9 Languages + HA Community)
const igLocales = {
  es: { // Spanish
    connecting: "Conectando...", live: "En directo", open: "Comms Abiertas", error_cam: "Error", no_lock: "Sin cerradura configurada",
    motion_detected: "Movimiento detectado", audio_active: "Audio activo", idle_status: "Sistema operativo", door_open_prefix: "Puerta abierta · Cerrando en",
    lbl_mic_off: "Micrófono", lbl_mic_on: "Activo", lbl_door_idle: "Puerta", lbl_door_open: "Abierta",
    talk_requesting: "Pidiendo turno...", talk_denied_msg: "Canal de voz ocupado por otro usuario", talk_busy: "Canal de voz en uso",
    talk_taken: "Otro usuario ha tomado el canal de voz", talk_silence: "El portero cerró el canal de voz por silencio",
    talk_legacy: "Este portero no confirma el turno de voz (firmware anterior)", lbl_mic_listen: "Escucha", clients_tip: "Clientes conectados",
    q_label: "Calidad", q_auto: "Auto", q_full: "Alta", q_low: "Baja", q_audio_only: "Solo audio",
    q_auto_loss: "Calidad ajustada automáticamente: pérdida de paquetes", q_auto_bw: "Calidad ajustada automáticamente: ancho de banda insuficiente",
    q_auto_sub: "El portero decide", q_full_sub: "Vídeo completo", q_low_sub: "~1 imagen/s (solo claves)", q_audio_only_sub: "Sin vídeo, solo sonido",
    q_low_warn: "Calidad baja: ~1 imagen por segundo. No es una avería.", talk_free_retry: "Canal de voz libre — ya puedes hablar",
    fs_enter: "Pantalla completa", fs_exit: "Salir de pantalla completa",
    door_confirm: "¿Abrir la puerta? Pulsa otra vez", lbl_door_confirm: "¿Abrir?",
    snd_on: "Silenciar", snd_off: "Escuchar", snd_ring: "Están llamando — sonido activado",
    door_opening: "Abriendo la puerta...", lbl_door_opening: "Abriendo", door_no_answer: "El portero no respondió — la puerta NO se ha abierto",
    conn_lan: "Home Assistant no llega al portero por la red local", paused: "En pausa", paused_tap: "En pausa para liberar el portero · toca para reanudar", retry_prefix: "Sin conexión · reintentando en",
    snd_blocked: "Toca el altavoz para oír", cred_revoked: "El portero rechazó el emparejamiento — vuelve a emparejarlo en Ajustes › Dispositivos y servicios",
    lbl_rec_off: "REC", lbl_rec_on: "Grabando", rec_start_tip: "Empezar a grabar", rec_stop_tip: "Parar la grabación", rec_no_answer: "Home Assistant no aceptó la orden de grabar", recordings_title: "Grabaciones",
    quick_reply_title: "Respuestas rápidas", qr_empty: "El portero no tiene respuestas rápidas configuradas", qr_load_error: "No se pudo obtener la lista del portero", qr_no_answer: "El portero no aceptó la respuesta rápida",
    db_switch: "Cambiar de portero", db_unnamed: "Portero sin nombre", no_doorbells: "No hay ningún portero. Añade la integración Islautopia Garage Doorbell en Ajustes › Dispositivos y servicios.", ed_nothing: "Esta tarjeta no tiene nada que configurar: muestra todos tus porteros y se cambia de uno a otro desde la propia tarjeta. Los ajustes están en la integración: Ajustes › Dispositivos y servicios › Islautopia Garage Doorbell › Configurar."
  },
  en: { // English (global fallback)
    connecting: "Connecting...", live: "Live", open: "Comms Open", error_cam: "Error", no_lock: "No lock configured",
    motion_detected: "Motion detected", audio_active: "Audio active", idle_status: "System idle", door_open_prefix: "Door open · Closing in",
    lbl_mic_off: "Microphone", lbl_mic_on: "Active", lbl_door_idle: "Door", lbl_door_open: "Open",
    talk_requesting: "Requesting turn...", talk_denied_msg: "Voice channel busy (another user)", talk_busy: "Voice channel in use",
    talk_taken: "Another user took the voice channel", talk_silence: "The doorbell closed the voice channel after silence",
    talk_legacy: "This doorbell doesn't confirm voice turns (older firmware)", lbl_mic_listen: "Listening", clients_tip: "Connected clients",
    q_label: "Quality", q_auto: "Auto", q_full: "High", q_low: "Low", q_audio_only: "Audio only",
    q_auto_loss: "Quality auto-adjusted: packet loss", q_auto_bw: "Quality auto-adjusted: not enough bandwidth",
    q_auto_sub: "The doorbell decides", q_full_sub: "Full video", q_low_sub: "~1 frame/s (keyframes only)", q_audio_only_sub: "No video, sound only",
    q_low_warn: "Low quality: about 1 frame per second. This is not a fault.", talk_free_retry: "Voice channel free — you can talk now",
    fs_enter: "Fullscreen", fs_exit: "Exit fullscreen",
    door_confirm: "Open the door? Press again", lbl_door_confirm: "Open?",
    snd_on: "Mute", snd_off: "Listen", snd_ring: "Someone is calling — sound on",
    door_opening: "Opening the door...", lbl_door_opening: "Opening", door_no_answer: "No answer from the doorbell — the door did NOT open",
    conn_lan: "Home Assistant can't reach the doorbell on the local network", paused: "Paused", paused_tap: "Paused to free the doorbell · tap to resume", retry_prefix: "No connection · retrying in",
    snd_blocked: "Tap the speaker to listen", cred_revoked: "The doorbell rejected this pairing — re-pair it in Settings › Devices & services",
    lbl_rec_off: "REC", lbl_rec_on: "Recording", rec_start_tip: "Start recording", rec_stop_tip: "Stop recording", rec_no_answer: "Home Assistant did not accept the recording request", recordings_title: "Recordings",
    quick_reply_title: "Quick replies", qr_empty: "The doorbell has no quick replies configured", qr_load_error: "Could not load the list from the doorbell", qr_no_answer: "The doorbell did not accept the quick reply",
    db_switch: "Switch doorbell", db_unnamed: "Unnamed doorbell", no_doorbells: "No doorbell found. Add the Islautopia Garage Doorbell integration in Settings › Devices & services.", ed_nothing: "There is nothing to configure in this card: it shows all your doorbells and you switch between them from the card itself. Settings live in the integration: Settings › Devices & services › Islautopia Garage Doorbell › Configure."
  },
  pt: { // Portuguese
    connecting: "Conectando...", live: "Ao vivo", open: "Comms Abertas", error_cam: "Erro", no_lock: "Sem fechadura configurada",
    motion_detected: "Movimento detectado", audio_active: "Áudio ativo", idle_status: "Sistema em repouso", door_open_prefix: "Porta aberta · Fechando em",
    lbl_mic_off: "Microfone", lbl_mic_on: "Ativo", lbl_door_idle: "Porta", lbl_door_open: "Aberta",
    talk_requesting: "A pedir a vez...", talk_denied_msg: "Canal de voz ocupado por outro utilizador", talk_busy: "Canal de voz em uso",
    talk_taken: "Outro utilizador tomou o canal de voz", talk_silence: "O porteiro fechou o canal de voz por silêncio",
    talk_legacy: "Este porteiro não confirma a vez de voz (firmware anterior)", lbl_mic_listen: "A ouvir", clients_tip: "Clientes ligados",
    q_label: "Qualidade", q_auto: "Auto", q_full: "Alta", q_low: "Baixa", q_audio_only: "Só áudio",
    q_auto_loss: "Qualidade ajustada automaticamente: perda de pacotes", q_auto_bw: "Qualidade ajustada automaticamente: largura de banda insuficiente",
    q_auto_sub: "O porteiro decide", q_full_sub: "Vídeo completo", q_low_sub: "~1 imagem/s (só chaves)", q_audio_only_sub: "Sem vídeo, só som",
    q_low_warn: "Qualidade baixa: ~1 imagem por segundo. Não é avaria.", talk_free_retry: "Canal de voz livre — já pode falar",
    fs_enter: "Ecrã inteiro", fs_exit: "Sair do ecrã inteiro",
    door_confirm: "Abrir a porta? Prima outra vez", lbl_door_confirm: "Abrir?",
    snd_on: "Silenciar", snd_off: "Ouvir", snd_ring: "Estão a chamar — som ligado",
    door_opening: "A abrir a porta...", lbl_door_opening: "A abrir", door_no_answer: "O porteiro não respondeu — a porta NÃO foi aberta",
    conn_lan: "O Home Assistant não chega ao porteiro pela rede local", paused: "Em pausa", paused_tap: "Em pausa para libertar o porteiro · toque para retomar", retry_prefix: "Sem ligação · a tentar de novo em",
    snd_blocked: "Toque no altifalante para ouvir", cred_revoked: "O porteiro rejeitou este emparelhamento — volte a emparelhá-lo em Definições › Dispositivos e serviços",
    lbl_rec_off: "REC", lbl_rec_on: "A gravar", rec_start_tip: "Começar a gravar", rec_stop_tip: "Parar a gravação", rec_no_answer: "O Home Assistant não aceitou o pedido de gravação", recordings_title: "Gravações",
    quick_reply_title: "Respostas rápidas", qr_empty: "A campainha não tem respostas rápidas configuradas", qr_load_error: "Não foi possível obter a lista da campainha", qr_no_answer: "A campainha não aceitou a resposta rápida",
    db_switch: "Mudar de campainha", db_unnamed: "Campainha sem nome", no_doorbells: "Nenhuma campainha encontrada. Adicione a integração Islautopia Garage Doorbell em Definições › Dispositivos e serviços.", ed_nothing: "Este cartão não tem nada para configurar: mostra todas as suas campainhas e muda-se de uma para outra no próprio cartão. As definições estão na integração: Definições › Dispositivos e serviços › Islautopia Garage Doorbell › Configurar."
  },
  de: { // German
    connecting: "Verbinde...", live: "Live", open: "Komm. offen", error_cam: "Fehler", no_lock: "Kein Schloss konfiguriert",
    motion_detected: "Bewegung erkannt", audio_active: "Audio aktiv", idle_status: "System im Ruhezustand", door_open_prefix: "Tür offen · Schließt in",
    lbl_mic_off: "Mikrofon", lbl_mic_on: "Aktiv", lbl_door_idle: "Tür", lbl_door_open: "Offen",
    talk_requesting: "Sprechrecht wird angefragt...", talk_denied_msg: "Sprachkanal von einem anderen Nutzer belegt", talk_busy: "Sprachkanal belegt",
    talk_taken: "Ein anderer Nutzer hat den Sprachkanal übernommen", talk_silence: "Die Türsprechanlage hat den Sprachkanal wegen Stille geschlossen",
    talk_legacy: "Diese Türsprechanlage bestätigt kein Sprechrecht (ältere Firmware)", lbl_mic_listen: "Zuhören", clients_tip: "Verbundene Clients",
    q_label: "Qualität", q_auto: "Auto", q_full: "Hoch", q_low: "Niedrig", q_audio_only: "Nur Audio",
    q_auto_loss: "Qualität automatisch angepasst: Paketverlust", q_auto_bw: "Qualität automatisch angepasst: zu wenig Bandbreite",
    q_auto_sub: "Die Türsprechanlage entscheidet", q_full_sub: "Volles Video", q_low_sub: "~1 Bild/s (nur Keyframes)", q_audio_only_sub: "Kein Video, nur Ton",
    q_low_warn: "Niedrige Qualität: ca. 1 Bild pro Sekunde. Kein Defekt.", talk_free_retry: "Sprachkanal frei — du kannst jetzt sprechen",
    fs_enter: "Vollbild", fs_exit: "Vollbild beenden",
    door_confirm: "Tür öffnen? Nochmal drücken", lbl_door_confirm: "Öffnen?",
    snd_on: "Stummschalten", snd_off: "Mithören", snd_ring: "Es klingelt — Ton an",
    door_opening: "Tür wird geöffnet...", lbl_door_opening: "Öffnet", door_no_answer: "Keine Antwort der Türsprechanlage — die Tür wurde NICHT geöffnet",
    conn_lan: "Home Assistant erreicht die Türsprechanlage im lokalen Netz nicht", paused: "Pausiert", paused_tap: "Pausiert, um die Türsprechanlage freizugeben · tippen zum Fortsetzen", retry_prefix: "Keine Verbindung · neuer Versuch in",
    snd_blocked: "Auf den Lautsprecher tippen, um zu hören", cred_revoked: "Die Türsprechanlage hat diese Kopplung abgelehnt — in Einstellungen › Geräte & Dienste neu koppeln",
    lbl_rec_off: "REC", lbl_rec_on: "Aufnahme läuft", rec_start_tip: "Aufnahme starten", rec_stop_tip: "Aufnahme stoppen", rec_no_answer: "Home Assistant hat die Aufnahme-Anfrage nicht angenommen", recordings_title: "Aufnahmen",
    quick_reply_title: "Schnellantworten", qr_empty: "Für die Klingel sind keine Schnellantworten eingerichtet", qr_load_error: "Liste konnte nicht von der Klingel geladen werden", qr_no_answer: "Die Klingel hat die Schnellantwort nicht angenommen",
    db_switch: "Klingel wechseln", db_unnamed: "Klingel ohne Namen", no_doorbells: "Keine Klingel gefunden. Füge die Integration Islautopia Garage Doorbell unter Einstellungen › Geräte & Dienste hinzu.", ed_nothing: "Diese Karte hat keine Einstellungen: Sie zeigt alle deine Klingeln, und du wechselst direkt in der Karte zwischen ihnen. Die Einstellungen liegen in der Integration: Einstellungen › Geräte & Dienste › Islautopia Garage Doorbell › Konfigurieren."
  },
  fr: { // French
    connecting: "Connexion...", live: "En direct", open: "Comms Ouvertes", error_cam: "Erreur", no_lock: "Aucune serrure configurée",
    motion_detected: "Mouvement détecté", audio_active: "Audio actif", idle_status: "Système au repos", door_open_prefix: "Porte ouverte · Fermeture dans",
    lbl_mic_off: "Microphone", lbl_mic_on: "Actif", lbl_door_idle: "Porte", lbl_door_open: "Ouverte",
    talk_requesting: "Demande de parole...", talk_denied_msg: "Canal vocal occupé par un autre utilisateur", talk_busy: "Canal vocal occupé",
    talk_taken: "Un autre utilisateur a pris le canal vocal", talk_silence: "Le portier a fermé le canal vocal après un silence",
    talk_legacy: "Ce portier ne confirme pas le tour de parole (firmware antérieur)", lbl_mic_listen: "Écoute", clients_tip: "Clients connectés",
    q_label: "Qualité", q_auto: "Auto", q_full: "Haute", q_low: "Basse", q_audio_only: "Audio seul",
    q_auto_loss: "Qualité ajustée automatiquement : perte de paquets", q_auto_bw: "Qualité ajustée automatiquement : bande passante insuffisante",
    q_auto_sub: "Le portier décide", q_full_sub: "Vidéo complète", q_low_sub: "~1 image/s (images clés)", q_audio_only_sub: "Pas de vidéo, son seul",
    q_low_warn: "Qualité basse : environ 1 image par seconde. Ce n'est pas une panne.", talk_free_retry: "Canal vocal libre — vous pouvez parler",
    fs_enter: "Plein écran", fs_exit: "Quitter le plein écran",
    door_confirm: "Ouvrir la porte ? Appuyez encore", lbl_door_confirm: "Ouvrir ?",
    snd_on: "Couper le son", snd_off: "Écouter", snd_ring: "On sonne — son activé",
    door_opening: "Ouverture de la porte...", lbl_door_opening: "Ouverture", door_no_answer: "Pas de réponse du portier — la porte n'a PAS été ouverte",
    conn_lan: "Home Assistant n'atteint pas l'interphone sur le réseau local", paused: "En pause", paused_tap: "En pause pour libérer l'interphone · touchez pour reprendre", retry_prefix: "Pas de connexion · nouvel essai dans",
    snd_blocked: "Touchez le haut-parleur pour écouter", cred_revoked: "Le portier a refusé cet appairage — réappairez-le dans Paramètres › Appareils et services",
    lbl_rec_off: "REC", lbl_rec_on: "Enregistrement", rec_start_tip: "Démarrer l'enregistrement", rec_stop_tip: "Arrêter l'enregistrement", rec_no_answer: "Home Assistant n'a pas accepté la demande d'enregistrement", recordings_title: "Enregistrements",
    quick_reply_title: "Réponses rapides", qr_empty: "Aucune réponse rapide configurée sur la sonnette", qr_load_error: "Impossible de récupérer la liste depuis la sonnette", qr_no_answer: "La sonnette n'a pas accepté la réponse rapide",
    db_switch: "Changer de sonnette", db_unnamed: "Sonnette sans nom", no_doorbells: "Aucune sonnette trouvée. Ajoutez l'intégration Islautopia Garage Doorbell dans Paramètres › Appareils et services.", ed_nothing: "Cette carte n'a rien à configurer : elle affiche toutes vos sonnettes et l'on passe de l'une à l'autre depuis la carte elle-même. Les réglages sont dans l'intégration : Paramètres › Appareils et services › Islautopia Garage Doorbell › Configurer."
  },
  ru: { // Russian
    connecting: "Подключение...", live: "В прямом эфире", open: "Связь открыта", error_cam: "Ошибка", no_lock: "Замок не настроен",
    motion_detected: "Обнаружено движение", audio_active: "Аудио активно", idle_status: "Система в режиме ожидания", door_open_prefix: "Дверь открыта · Закрытие через",
    lbl_mic_off: "Микрофон", lbl_mic_on: "Активен", lbl_door_idle: "Дверь", lbl_door_open: "Открыта",
    talk_requesting: "Запрос очереди...", talk_denied_msg: "Голосовой канал занят другим пользователем", talk_busy: "Голосовой канал занят",
    talk_taken: "Другой пользователь занял голосовой канал", talk_silence: "Домофон закрыл голосовой канал из-за тишины",
    talk_legacy: "Этот домофон не подтверждает очередь речи (старая прошивка)", lbl_mic_listen: "Прослушивание", clients_tip: "Подключенные клиенты",
    q_label: "Качество", q_auto: "Авто", q_full: "Высокое", q_low: "Низкое", q_audio_only: "Только звук",
    q_auto_loss: "Качество изменено автоматически: потеря пакетов", q_auto_bw: "Качество изменено автоматически: недостаточно полосы",
    q_auto_sub: "Решает домофон", q_full_sub: "Полное видео", q_low_sub: "~1 кадр/с (только ключевые)", q_audio_only_sub: "Без видео, только звук",
    q_low_warn: "Низкое качество: около 1 кадра в секунду. Это не неисправность.", talk_free_retry: "Голосовой канал свободен — можно говорить",
    fs_enter: "Полный экран", fs_exit: "Выйти из полного экрана",
    door_confirm: "Открыть дверь? Нажмите ещё раз", lbl_door_confirm: "Открыть?",
    snd_on: "Выключить звук", snd_off: "Слушать", snd_ring: "Звонят — звук включён",
    door_opening: "Открывание двери...", lbl_door_opening: "Открывание", door_no_answer: "Домофон не ответил — дверь НЕ открыта",
    conn_lan: "Home Assistant не может связаться с домофоном в локальной сети", paused: "Пауза", paused_tap: "Пауза, чтобы освободить домофон · коснитесь, чтобы продолжить", retry_prefix: "Нет связи · повтор через",
    snd_blocked: "Коснитесь динамика, чтобы слышать", cred_revoked: "Домофон отклонил эту привязку — выполните привязку заново в Настройки › Устройства и службы",
    lbl_rec_off: "REC", lbl_rec_on: "Запись", rec_start_tip: "Начать запись", rec_stop_tip: "Остановить запись", rec_no_answer: "Home Assistant не принял запрос на запись", recordings_title: "Записи",
    quick_reply_title: "Быстрые ответы", qr_empty: "На звонке не настроено ни одного быстрого ответа", qr_load_error: "Не удалось получить список со звонка", qr_no_answer: "Звонок не принял быстрый ответ",
    db_switch: "Сменить звонок", db_unnamed: "Звонок без имени", no_doorbells: "Звонок не найден. Добавьте интеграцию Islautopia Garage Doorbell в разделе Настройки › Устройства и службы.", ed_nothing: "В этой карточке нечего настраивать: она показывает все ваши звонки, а переключаться между ними можно прямо в карточке. Настройки находятся в интеграции: Настройки › Устройства и службы › Islautopia Garage Doorbell › Настроить."
  },
  zh: { // Mandarin Chinese
    connecting: "连接中...", live: "直播中", open: "通话中", error_cam: "错误", no_lock: "未配置门锁",
    motion_detected: "检测到移动", audio_active: "音频已激活", idle_status: "系统待机", door_open_prefix: "门已开 · 关闭倒计时",
    lbl_mic_off: "麦克风", lbl_mic_on: "已激活", lbl_door_idle: "门", lbl_door_open: "已开",
    talk_requesting: "正在请求发言权...", talk_denied_msg: "语音通道被其他用户占用", talk_busy: "语音通道占用中",
    talk_taken: "其他用户已接管语音通道", talk_silence: "门口机因静音已关闭语音通道",
    talk_legacy: "该门口机不确认发言权（旧固件）", lbl_mic_listen: "收听中", clients_tip: "已连接客户端",
    q_label: "画质", q_auto: "自动", q_full: "高", q_low: "低", q_audio_only: "仅音频",
    q_auto_loss: "画质已自动调整：丢包", q_auto_bw: "画质已自动调整：带宽不足",
    q_auto_sub: "由门口机决定", q_full_sub: "完整视频", q_low_sub: "约1帧/秒（仅关键帧）", q_audio_only_sub: "无视频，仅声音",
    q_low_warn: "低画质：约每秒1帧，这不是故障。", talk_free_retry: "语音通道已空闲 — 现在可以讲话",
    fs_enter: "全屏", fs_exit: "退出全屏",
    door_confirm: "确定开门？再按一次", lbl_door_confirm: "开门？",
    snd_on: "静音", snd_off: "收听", snd_ring: "有人按门铃 — 已开启声音",
    door_opening: "正在开门...", lbl_door_opening: "开门中", door_no_answer: "门口机没有响应 — 门并未打开",
    conn_lan: "Home Assistant 无法通过局域网连接门铃", paused: "已暂停", paused_tap: "已暂停以释放门铃 · 轻触继续", retry_prefix: "无连接 · 重试倒计时",
    snd_blocked: "点击扬声器以收听", cred_revoked: "门口机拒绝了此配对 — 请在 设置 › 设备与服务 中重新配对",
    lbl_rec_off: "REC", lbl_rec_on: "录制中", rec_start_tip: "开始录制", rec_stop_tip: "停止录制", rec_no_answer: "Home Assistant 未接受录制请求", recordings_title: "录像",
    quick_reply_title: "快捷回复", qr_empty: "门铃未配置任何快捷回复", qr_load_error: "无法从门铃获取列表", qr_no_answer: "门铃未接受该快捷回复",
    db_switch: "切换门铃", db_unnamed: "未命名的门铃", no_doorbells: "未找到门铃。请在 设置 › 设备与服务 中添加 Islautopia Garage Doorbell 集成。", ed_nothing: "此卡片无需任何配置：它会显示您的所有门铃，并可直接在卡片中切换。设置位于集成中：设置 › 设备与服务 › Islautopia Garage Doorbell › 配置。"
  },
  hi: { // Hindi
    connecting: "कनेक्ट हो रहा है...", live: "लाइव", open: "संचार चालू", error_cam: "त्रुटि", no_lock: "कोई लॉक कॉन्फ़िगर नहीं",
    motion_detected: "गति का पता चला", audio_active: "ऑडियो सक्रिय", idle_status: "सिस्टम निष्क्रिय", door_open_prefix: "दरवाज़ा खुला · बंद हो रहा है",
    lbl_mic_off: "माइक्रोफ़ोन", lbl_mic_on: "सक्रिय", lbl_door_idle: "दरवाज़ा", lbl_door_open: "खुला",
    talk_requesting: "बोलने की बारी मांगी जा रही है...", talk_denied_msg: "वॉइस चैनल किसी अन्य उपयोगकर्ता के पास है", talk_busy: "वॉइस चैनल व्यस्त",
    talk_taken: "किसी अन्य उपयोगकर्ता ने वॉइस चैनल ले लिया", talk_silence: "खामोशी के कारण डोरबेल ने वॉइस चैनल बंद कर दिया",
    talk_legacy: "यह डोरबेल बोलने की बारी की पुष्टि नहीं करता (पुराना फर्मवेयर)", lbl_mic_listen: "सुन रहे हैं", clients_tip: "जुड़े क्लाइंट",
    q_label: "गुणवत्ता", q_auto: "ऑटो", q_full: "उच्च", q_low: "निम्न", q_audio_only: "केवल ऑडियो",
    q_auto_loss: "गुणवत्ता स्वतः समायोजित: पैकेट हानि", q_auto_bw: "गुणवत्ता स्वतः समायोजित: अपर्याप्त बैंडविड्थ",
    q_auto_sub: "डोरबेल तय करता है", q_full_sub: "पूरा वीडियो", q_low_sub: "~1 फ्रेम/सेकंड (केवल कीफ्रेम)", q_audio_only_sub: "वीडियो नहीं, केवल ध्वनि",
    q_low_warn: "कम गुणवत्ता: लगभग 1 फ्रेम प्रति सेकंड। यह खराबी नहीं है।", talk_free_retry: "वॉइस चैनल खाली — अब आप बोल सकते हैं",
    fs_enter: "पूर्ण स्क्रीन", fs_exit: "पूर्ण स्क्रीन से बाहर",
    door_confirm: "दरवाज़ा खोलें? फिर से दबाएँ", lbl_door_confirm: "खोलें?",
    snd_on: "म्यूट करें", snd_off: "सुनें", snd_ring: "कोई घंटी बजा रहा है — ध्वनि चालू",
    door_opening: "दरवाज़ा खोला जा रहा है...", lbl_door_opening: "खुल रहा है", door_no_answer: "डोरबेल ने जवाब नहीं दिया — दरवाज़ा नहीं खुला",
    conn_lan: "Home Assistant लोकल नेटवर्क पर डोरबेल तक नहीं पहुँच पा रहा", paused: "रुका हुआ", paused_tap: "डोरबेल खाली करने के लिए रुका · फिर शुरू करने के लिए छुएँ", retry_prefix: "कनेक्शन नहीं · फिर कोशिश",
    snd_blocked: "सुनने के लिए स्पीकर पर टैप करें", cred_revoked: "डोरबेल ने यह पेयरिंग अस्वीकार कर दी — सेटिंग्स › डिवाइस और सेवाएँ में दोबारा पेयर करें",
    lbl_rec_off: "REC", lbl_rec_on: "रिकॉर्डिंग हो रही है", rec_start_tip: "रिकॉर्डिंग शुरू करें", rec_stop_tip: "रिकॉर्डिंग रोकें", rec_no_answer: "Home Assistant ने रिकॉर्डिंग का अनुरोध स्वीकार नहीं किया", recordings_title: "रिकॉर्डिंग",
    quick_reply_title: "त्वरित उत्तर", qr_empty: "डोरबेल में कोई त्वरित उत्तर कॉन्फ़िगर नहीं है", qr_load_error: "डोरबेल से सूची प्राप्त नहीं हो सकी", qr_no_answer: "डोरबेल ने त्वरित उत्तर स्वीकार नहीं किया",
    db_switch: "डोरबेल बदलें", db_unnamed: "बिना नाम की डोरबेल", no_doorbells: "कोई डोरबेल नहीं मिली। सेटिंग्स › डिवाइस और सेवाएँ में Islautopia Garage Doorbell इंटीग्रेशन जोड़ें।", ed_nothing: "इस कार्ड में कॉन्फ़िगर करने के लिए कुछ नहीं है: यह आपकी सभी डोरबेल दिखाता है और आप कार्ड से ही उनके बीच बदल सकते हैं। सेटिंग्स इंटीग्रेशन में हैं: सेटिंग्स › डिवाइस और सेवाएँ › Islautopia Garage Doorbell › कॉन्फ़िगर करें।"
  },
  ar: { // Arabic
    connecting: "جارٍ الاتصال...", live: "مباشر", open: "اتصال مفتوح", error_cam: "خطأ", no_lock: "لا يوجد قفل مُهيأ",
    motion_detected: "تم اكتشاف حركة", audio_active: "الصوت نشط", idle_status: "النظام في وضع الخمول", door_open_prefix: "الباب مفتوح · يُغلق خلال",
    lbl_mic_off: "الميكروفون", lbl_mic_on: "نشط", lbl_door_idle: "الباب", lbl_door_open: "مفتوح",
    talk_requesting: "جارٍ طلب الدور...", talk_denied_msg: "قناة الصوت مشغولة بمستخدم آخر", talk_busy: "قناة الصوت مشغولة",
    talk_taken: "استحوذ مستخدم آخر على قناة الصوت", talk_silence: "أغلق الجهاز قناة الصوت بسبب الصمت",
    talk_legacy: "هذا الجهاز لا يؤكد دور التحدث (إصدار سابق)", lbl_mic_listen: "استماع", clients_tip: "العملاء المتصلون",
    q_label: "الجودة", q_auto: "تلقائي", q_full: "عالية", q_low: "منخفضة", q_audio_only: "صوت فقط",
    q_auto_loss: "تم ضبط الجودة تلقائياً: فقد الحزم", q_auto_bw: "تم ضبط الجودة تلقائياً: عرض نطاق غير كافٍ",
    q_auto_sub: "الجهاز يقرر", q_full_sub: "فيديو كامل", q_low_sub: "~إطار واحد/ث (إطارات مفتاحية فقط)", q_audio_only_sub: "بدون فيديو، صوت فقط",
    q_low_warn: "جودة منخفضة: إطار واحد تقريباً في الثانية. ليس عطلاً.", talk_free_retry: "قناة الصوت متاحة — يمكنك التحدث الآن",
    fs_enter: "ملء الشاشة", fs_exit: "إنهاء ملء الشاشة",
    door_confirm: "هل تفتح الباب؟ اضغط مرة أخرى", lbl_door_confirm: "فتح؟",
    snd_on: "كتم الصوت", snd_off: "استماع", snd_ring: "هناك من يطرق — تم تشغيل الصوت",
    door_opening: "جارٍ فتح الباب...", lbl_door_opening: "جارٍ الفتح", door_no_answer: "لا رد من الجهاز — لم يُفتح الباب",
    conn_lan: "لا يصل Home Assistant إلى الجرس عبر الشبكة المحلية", paused: "متوقف مؤقتاً", paused_tap: "متوقف مؤقتاً لتحرير الجرس · المس للمتابعة", retry_prefix: "لا يوجد اتصال · إعادة المحاولة خلال",
    snd_blocked: "المس مكبر الصوت للاستماع", cred_revoked: "رفض الجهاز هذا الاقتران — أعد الاقتران من الإعدادات › الأجهزة والخدمات",
    lbl_rec_off: "REC", lbl_rec_on: "جارٍ التسجيل", rec_start_tip: "بدء التسجيل", rec_stop_tip: "إيقاف التسجيل", rec_no_answer: "لم يقبل Home Assistant طلب التسجيل", recordings_title: "التسجيلات",
    quick_reply_title: "الردود السريعة", qr_empty: "لا توجد ردود سريعة مُعدة على الجرس", qr_load_error: "تعذر جلب القائمة من الجرس", qr_no_answer: "لم يقبل الجرس الرد السريع",
    db_switch: "تبديل الجرس", db_unnamed: "جرس بدون اسم", no_doorbells: "لم يتم العثور على أي جرس. أضف تكامل Islautopia Garage Doorbell من الإعدادات › الأجهزة والخدمات.", ed_nothing: "لا يوجد ما يمكن ضبطه في هذه البطاقة: فهي تعرض جميع أجراسك ويمكنك التبديل بينها من البطاقة نفسها. الإعدادات موجودة في التكامل: الإعدادات › الأجهزة والخدمات › Islautopia Garage Doorbell › تكوين."
  }
};

// ==============================================================================
// NOTIFICATION BELL (1.9.7, Iñaki 2026-09-25: «the bell is a great addition ... with a
// filter by type and a time filter identical to the videos' one»). Text, groups and icons copied
// from the apps (Android lib/domain/app_event.dart + event_texts.dart) so an alert is called
// the same in all three clients. The time filter is the SAME ONE used by Recordings in the apps
// (RecordingTimeFilter: last hour / 6 hours / day / week, day and week are navigable, day is the
// default) - not one invented here.
//
// `aviso` = the apps' catalog `avisoDefault` (§1.16): what goes into the bell by
// default. The card can't read per-user preferences from the VPS (and it shouldn't: the card
// doesn't talk to the VPS), so it uses the contract's default. Without this, every time someone opens
// this same card (viewer_joined) the red dot would light up: a self-triggered alert.
// An unknown type is SHOWN the same way ("status" group), just like the apps do.
// ==============================================================================
const IG_EVENT_KINDS = {
  ring:                { g: 'door',     notice: true,  icon: 'mdi:doorbell',                  c: 'blue'  },
  visitor:             { g: 'door',     notice: true,  icon: 'mdi:account-outline',           c: 'blue'  },
  package:             { g: 'door',     notice: true,  icon: 'mdi:package-variant-closed',    c: 'blue'  },
  person_with_package: { g: 'door',     notice: false, icon: 'mdi:package-variant-closed',    c: 'blue'  },
  package_gone:        { g: 'door',     notice: true,  icon: 'mdi:alert-octagon-outline',     c: 'amber' },
  call_answered:       { g: 'call',     notice: true,  icon: 'mdi:phone-incoming',            c: 'green' },
  call_declined:       { g: 'call',     notice: false, icon: 'mdi:phone-hangup-outline',      c: 'muted' },
  call_missed:         { g: 'call',     notice: true,  icon: 'mdi:phone-missed-outline',      c: 'amber' },
  visitor_message:     { g: 'call',     notice: true,  icon: 'mdi:voicemail',                 c: 'blue'  },
  door_opened:         { g: 'lock',     notice: true,  icon: 'mdi:lock-open-variant-outline', c: 'green' },
  device_offline:      { g: 'health',   notice: true,  icon: 'mdi:cloud-off-outline',         c: 'red'   },
  device_online:       { g: 'health',   notice: true,  icon: 'mdi:cloud-check-outline',       c: 'green' },
  storage_problem:     { g: 'health',   notice: true,  icon: 'mdi:sd',                        c: 'red'   },
  firmware_available:  { g: 'health',   notice: true,  icon: 'mdi:update',                    c: 'blue'  },
  unexpected_reboot:   { g: 'health',   notice: true,  icon: 'mdi:restart-alert',             c: 'amber' },
  client_paired:       { g: 'security', notice: true,  icon: 'mdi:devices',                   c: 'amber' },
  user_added:          { g: 'security', notice: true,  icon: 'mdi:account-plus-outline',      c: 'blue'  },
  user_revoked:        { g: 'security', notice: true,  icon: 'mdi:account-remove-outline',    c: 'amber' },
  login_failed:        { g: 'security', notice: false, icon: 'mdi:shield-alert-outline',      c: 'red'   },
  key_denied:          { g: 'security', notice: true,  icon: 'mdi:key-remove',                c: 'amber' },
  key_locked:          { g: 'security', notice: true,  icon: 'mdi:lock-alert-outline',        c: 'red'   },
  mode_changed:        { g: 'status',   notice: true,  icon: 'mdi:tune-variant',              c: 'muted' },
  ring_suppressed:     { g: 'status',   notice: true,  icon: 'mdi:bell-off-outline',          c: 'amber' },
  viewer_joined:       { g: 'status',   notice: false, icon: 'mdi:eye-outline',               c: 'muted' },
};
const IG_EVENT_GROUPS = ['door', 'call', 'lock', 'health', 'security', 'status'];
const IG_EV_RANGES = ['lastHour', 'last6Hours', 'day', 'week'];

const IG_EV_TEXT = {
  en: {
    bell: 'Notices', bell_new: 'Notices — something new', all: 'All', back: 'Back',
    g_door: 'At the door', g_call: 'The call', g_lock: 'The door', g_health: 'Device health', g_security: 'Accounts and security', g_status: 'Status',
    r_lastHour: 'Last hour', r_last6Hours: '6 hours', r_day: 'Day', r_week: 'Week',
    today: 'Today', yesterday: 'Yesterday', this_week: 'This week', last_week: 'Last week', prev: 'Earlier', next: 'Later',
    empty: 'No notices in this period', empty_hint: 'What happens at your door shows up here: rings, packages, openings…',
    loading: 'Loading…', load_err: 'Could not read the history from Home Assistant', no_entity: 'This doorbell has no events entity in Home Assistant',
    m0: 'Normal', m1: 'Away', m2: 'Do not disturb', m3: 'Custom', mode_to: 'Mode: {m}', by: 'by {w}',
    ring: 'Doorbell pressed', visitor: 'Visitor detected', package: 'Package at the door', person_with_package: 'Person with a package', package_gone: 'Package no longer visible',
    call_answered: 'Call answered', call_declined: 'Call declined', call_missed: 'Nobody answered', visitor_message: 'Message left by the visitor',
    door_opened: 'Door opened', device_offline: 'Doorbell offline', device_online: 'Doorbell back online', storage_problem: 'Problem with the card',
    firmware_available: 'Firmware update available', unexpected_reboot: 'Unexpected restart', client_paired: 'New client paired', user_added: 'User added',
    user_revoked: 'User revoked', login_failed: 'Failed sign-in attempts', key_denied: 'Key refused', key_locked: 'Key locked after failed attempts',
    mode_changed: 'Mode changed', ring_suppressed: 'Doorbell silenced by Do not disturb', viewer_joined: 'Someone is watching the camera', unknown: 'Notice',
    mode_failed: 'The doorbell did not change mode', mode_failed_why: 'The doorbell did not change mode: {w}',
  },
  es: {
    bell: 'Avisos', bell_new: 'Avisos — hay novedades', all: 'Todo', back: 'Volver',
    g_door: 'En la puerta', g_call: 'La llamada', g_lock: 'La puerta', g_health: 'Salud del aparato', g_security: 'Cuentas y seguridad', g_status: 'Estado',
    r_lastHour: 'Última hora', r_last6Hours: '6 horas', r_day: 'Día', r_week: 'Semana',
    today: 'Hoy', yesterday: 'Ayer', this_week: 'Esta semana', last_week: 'Semana pasada', prev: 'Anterior', next: 'Siguiente',
    empty: 'No hay avisos en este periodo', empty_hint: 'Aquí aparece lo que pasa en la puerta: timbrazos, paquetes, aperturas…',
    loading: 'Cargando…', load_err: 'No se pudo leer el historial de Home Assistant', no_entity: 'Este portero no tiene entidad de eventos en Home Assistant',
    m0: 'Normal', m1: 'Ausente', m2: 'No molestar', m3: 'Personalizado', mode_to: 'Modo: {m}', by: 'por {w}',
    ring: 'Timbre pulsado', visitor: 'Visitante detectado', package: 'Paquete en la puerta', person_with_package: 'Persona con paquete', package_gone: 'Paquete deja de verse',
    call_answered: 'Llamada atendida', call_declined: 'Llamada rechazada', call_missed: 'Nadie contestó', visitor_message: 'Mensaje dejado por el visitante',
    door_opened: 'Puerta abierta', device_offline: 'Videoportero sin conexión', device_online: 'Videoportero reconectado', storage_problem: 'Problema con la tarjeta',
    firmware_available: 'Actualización de firmware disponible', unexpected_reboot: 'Reinicio inesperado', client_paired: 'Nuevo cliente emparejado', user_added: 'Usuario añadido',
    user_revoked: 'Usuario revocado', login_failed: 'Intentos de acceso fallidos', key_denied: 'Llave rechazada', key_locked: 'Llave bloqueada tras intentos fallidos',
    mode_changed: 'Modo cambiado', ring_suppressed: 'Timbre silenciado por No molestar', viewer_joined: 'Alguien está viendo la cámara', unknown: 'Aviso',
    mode_failed: 'El portero no cambió de modo', mode_failed_why: 'El portero no cambió de modo: {w}',
  },
  pt: {
    bell: 'Avisos', bell_new: 'Avisos — há novidades', all: 'Tudo', back: 'Voltar',
    g_door: 'À porta', g_call: 'A chamada', g_lock: 'A porta', g_health: 'Saúde do aparelho', g_security: 'Contas e segurança', g_status: 'Estado',
    r_lastHour: 'Última hora', r_last6Hours: '6 horas', r_day: 'Dia', r_week: 'Semana',
    today: 'Hoje', yesterday: 'Ontem', this_week: 'Esta semana', last_week: 'Semana passada', prev: 'Anterior', next: 'Seguinte',
    empty: 'Não há avisos neste período', empty_hint: 'Aqui aparece o que acontece à porta: toques, encomendas, aberturas…',
    loading: 'A carregar…', load_err: 'Não foi possível ler o histórico do Home Assistant', no_entity: 'Este videoporteiro não tem entidade de eventos no Home Assistant',
    m0: 'Normal', m1: 'Ausente', m2: 'Não incomodar', m3: 'Personalizado', mode_to: 'Modo: {m}', by: 'por {w}',
    ring: 'Campainha tocada', visitor: 'Visitante detetado', package: 'Encomenda à porta', person_with_package: 'Pessoa com encomenda', package_gone: 'Encomenda deixa de se ver',
    call_answered: 'Chamada atendida', call_declined: 'Chamada rejeitada', call_missed: 'Ninguém atendeu', visitor_message: 'Mensagem deixada pelo visitante',
    door_opened: 'Porta aberta', device_offline: 'Videoporteiro sem ligação', device_online: 'Videoporteiro reconectado', storage_problem: 'Problema com o cartão',
    firmware_available: 'Atualização de firmware disponível', unexpected_reboot: 'Reinício inesperado', client_paired: 'Novo cliente emparelhado', user_added: 'Utilizador adicionado',
    user_revoked: 'Utilizador revogado', login_failed: 'Tentativas de acesso falhadas', key_denied: 'Chave recusada', key_locked: 'Chave bloqueada após tentativas falhadas',
    mode_changed: 'Modo alterado', ring_suppressed: 'Campainha silenciada por Não incomodar', viewer_joined: 'Alguém está a ver a câmara', unknown: 'Aviso',
    mode_failed: 'O videoporteiro não mudou de modo', mode_failed_why: 'O videoporteiro não mudou de modo: {w}',
  },
  de: {
    bell: 'Meldungen', bell_new: 'Meldungen — es gibt Neues', all: 'Alles', back: 'Zurück',
    g_door: 'An der Tür', g_call: 'Der Anruf', g_lock: 'Die Tür', g_health: 'Gerätezustand', g_security: 'Konten und Sicherheit', g_status: 'Status',
    r_lastHour: 'Letzte Stunde', r_last6Hours: '6 Stunden', r_day: 'Tag', r_week: 'Woche',
    today: 'Heute', yesterday: 'Gestern', this_week: 'Diese Woche', last_week: 'Letzte Woche', prev: 'Früher', next: 'Später',
    empty: 'Keine Meldungen in diesem Zeitraum', empty_hint: 'Hier erscheint, was an deiner Tür passiert: Klingeln, Pakete, Öffnungen…',
    loading: 'Wird geladen…', load_err: 'Der Verlauf von Home Assistant konnte nicht gelesen werden', no_entity: 'Diese Türsprechanlage hat keine Ereignis-Entität in Home Assistant',
    m0: 'Normal', m1: 'Abwesend', m2: 'Nicht stören', m3: 'Benutzerdefiniert', mode_to: 'Modus: {m}', by: 'von {w}',
    ring: 'Klingel gedrückt', visitor: 'Besucher erkannt', package: 'Paket an der Tür', person_with_package: 'Person mit Paket', package_gone: 'Paket nicht mehr zu sehen',
    call_answered: 'Anruf angenommen', call_declined: 'Anruf abgelehnt', call_missed: 'Niemand hat abgenommen', visitor_message: 'Nachricht des Besuchers',
    door_opened: 'Tür geöffnet', device_offline: 'Türsprechanlage offline', device_online: 'Türsprechanlage wieder online', storage_problem: 'Problem mit der Karte',
    firmware_available: 'Firmware-Update verfügbar', unexpected_reboot: 'Unerwarteter Neustart', client_paired: 'Neuer Client gekoppelt', user_added: 'Benutzer hinzugefügt',
    user_revoked: 'Benutzer entzogen', login_failed: 'Fehlgeschlagene Anmeldeversuche', key_denied: 'Schlüssel abgelehnt', key_locked: 'Schlüssel nach Fehlversuchen gesperrt',
    mode_changed: 'Modus geändert', ring_suppressed: 'Klingel durch Nicht stören stummgeschaltet', viewer_joined: 'Jemand sieht die Kamera an', unknown: 'Meldung',
    mode_failed: 'Die Türsprechanlage hat den Modus nicht geändert', mode_failed_why: 'Die Türsprechanlage hat den Modus nicht geändert: {w}',
  },
  fr: {
    bell: 'Avis', bell_new: 'Avis — du nouveau', all: 'Tout', back: 'Retour',
    g_door: 'À la porte', g_call: "L'appel", g_lock: 'La porte', g_health: "État de l'appareil", g_security: 'Comptes et sécurité', g_status: 'État',
    r_lastHour: 'Dernière heure', r_last6Hours: '6 heures', r_day: 'Jour', r_week: 'Semaine',
    today: "Aujourd'hui", yesterday: 'Hier', this_week: 'Cette semaine', last_week: 'Semaine dernière', prev: 'Avant', next: 'Après',
    empty: 'Aucun avis sur cette période', empty_hint: 'Ce qui se passe à votre porte apparaît ici : sonneries, colis, ouvertures…',
    loading: 'Chargement…', load_err: "Impossible de lire l'historique de Home Assistant", no_entity: "Cet interphone n'a pas d'entité d'événements dans Home Assistant",
    m0: 'Normal', m1: 'Absent', m2: 'Ne pas déranger', m3: 'Personnalisé', mode_to: 'Mode : {m}', by: 'par {w}',
    ring: 'Sonnette actionnée', visitor: 'Visiteur détecté', package: 'Colis à la porte', person_with_package: 'Personne avec un colis', package_gone: "Le colis n'est plus visible",
    call_answered: 'Appel pris', call_declined: 'Appel refusé', call_missed: "Personne n'a répondu", visitor_message: 'Message laissé par le visiteur',
    door_opened: 'Porte ouverte', device_offline: 'Interphone vidéo hors ligne', device_online: 'Interphone vidéo reconnecté', storage_problem: 'Problème avec la carte',
    firmware_available: 'Mise à jour du firmware disponible', unexpected_reboot: 'Redémarrage inattendu', client_paired: 'Nouveau client associé', user_added: 'Utilisateur ajouté',
    user_revoked: 'Utilisateur révoqué', login_failed: 'Tentatives de connexion échouées', key_denied: 'Clé refusée', key_locked: 'Clé bloquée après des échecs',
    mode_changed: 'Mode changé', ring_suppressed: 'Sonnette coupée par Ne pas déranger', viewer_joined: "Quelqu'un regarde la caméra", unknown: 'Avis',
    mode_failed: "L'interphone n'a pas changé de mode", mode_failed_why: "L'interphone n'a pas changé de mode : {w}",
  },
  ru: {
    bell: 'Уведомления', bell_new: 'Уведомления — есть новые', all: 'Все', back: 'Назад',
    g_door: 'У двери', g_call: 'Вызов', g_lock: 'Дверь', g_health: 'Состояние устройства', g_security: 'Учётные записи и безопасность', g_status: 'Статус',
    r_lastHour: 'Последний час', r_last6Hours: '6 часов', r_day: 'День', r_week: 'Неделя',
    today: 'Сегодня', yesterday: 'Вчера', this_week: 'Эта неделя', last_week: 'Прошлая неделя', prev: 'Раньше', next: 'Позже',
    empty: 'За этот период уведомлений нет', empty_hint: 'Здесь появляется то, что происходит у двери: звонки, посылки, открытия…',
    loading: 'Загрузка…', load_err: 'Не удалось прочитать историю Home Assistant', no_entity: 'У этого домофона нет сущности событий в Home Assistant',
    m0: 'Обычный', m1: 'Нет дома', m2: 'Не беспокоить', m3: 'Свой', mode_to: 'Режим: {m}', by: '{w}',
    ring: 'Нажат звонок', visitor: 'Обнаружен посетитель', package: 'Посылка у двери', person_with_package: 'Человек с посылкой', package_gone: 'Посылка больше не видна',
    call_answered: 'Вызов принят', call_declined: 'Вызов отклонён', call_missed: 'Никто не ответил', visitor_message: 'Сообщение от посетителя',
    door_opened: 'Дверь открыта', device_offline: 'Домофон не в сети', device_online: 'Домофон снова в сети', storage_problem: 'Проблема с картой памяти',
    firmware_available: 'Доступно обновление прошивки', unexpected_reboot: 'Неожиданная перезагрузка', client_paired: 'Подключён новый клиент', user_added: 'Пользователь добавлен',
    user_revoked: 'Доступ пользователя отозван', login_failed: 'Неудачные попытки входа', key_denied: 'Ключ отклонён', key_locked: 'Ключ заблокирован после неудачных попыток',
    mode_changed: 'Режим изменён', ring_suppressed: 'Звонок заглушён режимом «Не беспокоить»', viewer_joined: 'Кто-то смотрит камеру', unknown: 'Уведомление',
    mode_failed: 'Домофон не сменил режим', mode_failed_why: 'Домофон не сменил режим: {w}',
  },
  zh: {
    bell: '通知', bell_new: '通知 — 有新消息', all: '全部', back: '返回',
    g_door: '门口', g_call: '通话', g_lock: '门锁', g_health: '设备状态', g_security: '账户与安全', g_status: '状态',
    r_lastHour: '最近一小时', r_last6Hours: '6 小时', r_day: '天', r_week: '周',
    today: '今天', yesterday: '昨天', this_week: '本周', last_week: '上周', prev: '更早', next: '更晚',
    empty: '此时段没有通知', empty_hint: '门口发生的事情会显示在这里：按铃、包裹、开门……',
    loading: '加载中…', load_err: '无法读取 Home Assistant 历史记录', no_entity: '此门铃在 Home Assistant 中没有事件实体',
    m0: '正常', m1: '外出', m2: '请勿打扰', m3: '自定义', mode_to: '模式：{m}', by: '{w}',
    ring: '门铃被按下', visitor: '检测到访客', package: '门口有包裹', person_with_package: '有人拿着包裹', package_gone: '包裹不见了',
    call_answered: '通话已接听', call_declined: '通话被拒绝', call_missed: '无人接听', visitor_message: '访客留言',
    door_opened: '门已打开', device_offline: '门铃离线', device_online: '门铃已恢复在线', storage_problem: '存储卡有问题',
    firmware_available: '有可用的固件更新', unexpected_reboot: '意外重启', client_paired: '新客户端已配对', user_added: '已添加用户',
    user_revoked: '已撤销用户', login_failed: '登录失败尝试', key_denied: '钥匙被拒绝', key_locked: '多次失败后钥匙被锁定',
    mode_changed: '模式已更改', ring_suppressed: '门铃被“请勿打扰”静音', viewer_joined: '有人正在查看摄像头', unknown: '通知',
    mode_failed: '门铃未切换模式', mode_failed_why: '门铃未切换模式：{w}',
  },
  hi: {
    bell: 'सूचनाएँ', bell_new: 'सूचनाएँ — कुछ नया है', all: 'सभी', back: 'वापस',
    g_door: 'दरवाज़े पर', g_call: 'कॉल', g_lock: 'दरवाज़ा', g_health: 'उपकरण की स्थिति', g_security: 'खाते और सुरक्षा', g_status: 'स्थिति',
    r_lastHour: 'पिछला घंटा', r_last6Hours: '6 घंटे', r_day: 'दिन', r_week: 'सप्ताह',
    today: 'आज', yesterday: 'कल', this_week: 'इस सप्ताह', last_week: 'पिछले सप्ताह', prev: 'पहले', next: 'बाद में',
    empty: 'इस अवधि में कोई सूचना नहीं', empty_hint: 'आपके दरवाज़े पर जो होता है वह यहाँ दिखता है: घंटी, पार्सल, दरवाज़ा खुलना…',
    loading: 'लोड हो रहा है…', load_err: 'Home Assistant का इतिहास नहीं पढ़ा जा सका', no_entity: 'इस डोरबेल की Home Assistant में कोई इवेंट एंटिटी नहीं है',
    m0: 'सामान्य', m1: 'बाहर', m2: 'परेशान न करें', m3: 'कस्टम', mode_to: 'मोड: {m}', by: '{w}',
    ring: 'घंटी बजाई गई', visitor: 'आगंतुक का पता चला', package: 'दरवाज़े पर पार्सल', person_with_package: 'पार्सल के साथ व्यक्ति', package_gone: 'पार्सल अब नहीं दिख रहा',
    call_answered: 'कॉल उठाई गई', call_declined: 'कॉल अस्वीकार', call_missed: 'किसी ने जवाब नहीं दिया', visitor_message: 'आगंतुक का संदेश',
    door_opened: 'दरवाज़ा खोला गया', device_offline: 'डोरबेल ऑफ़लाइन', device_online: 'डोरबेल फिर ऑनलाइन', storage_problem: 'कार्ड में समस्या',
    firmware_available: 'फ़र्मवेयर अपडेट उपलब्ध', unexpected_reboot: 'अप्रत्याशित रीस्टार्ट', client_paired: 'नया क्लाइंट जोड़ा गया', user_added: 'उपयोगकर्ता जोड़ा गया',
    user_revoked: 'उपयोगकर्ता हटाया गया', login_failed: 'असफल साइन-इन प्रयास', key_denied: 'चाबी अस्वीकार', key_locked: 'असफल प्रयासों के बाद चाबी लॉक',
    mode_changed: 'मोड बदला गया', ring_suppressed: 'परेशान न करें से घंटी मौन', viewer_joined: 'कोई कैमरा देख रहा है', unknown: 'सूचना',
    mode_failed: 'डोरबेल ने मोड नहीं बदला', mode_failed_why: 'डोरबेल ने मोड नहीं बदला: {w}',
  },
  ar: {
    bell: 'التنبيهات', bell_new: 'التنبيهات — يوجد جديد', all: 'الكل', back: 'رجوع',
    g_door: 'عند الباب', g_call: 'المكالمة', g_lock: 'الباب', g_health: 'حالة الجهاز', g_security: 'الحسابات والأمان', g_status: 'الحالة',
    r_lastHour: 'آخر ساعة', r_last6Hours: '6 ساعات', r_day: 'يوم', r_week: 'أسبوع',
    today: 'اليوم', yesterday: 'أمس', this_week: 'هذا الأسبوع', last_week: 'الأسبوع الماضي', prev: 'أقدم', next: 'أحدث',
    empty: 'لا توجد تنبيهات في هذه الفترة', empty_hint: 'يظهر هنا ما يحدث عند بابك: الرنين، الطرود، فتح الباب…',
    loading: 'جارٍ التحميل…', load_err: 'تعذّرت قراءة سجل Home Assistant', no_entity: 'لا يملك جرس الباب هذا كيان أحداث في Home Assistant',
    m0: 'عادي', m1: 'خارج المنزل', m2: 'عدم الإزعاج', m3: 'مخصص', mode_to: 'الوضع: {m}', by: '{w}',
    ring: 'تم الضغط على الجرس', visitor: 'تم اكتشاف زائر', package: 'طرد عند الباب', person_with_package: 'شخص يحمل طرداً', package_gone: 'لم يعد الطرد ظاهراً',
    call_answered: 'تم الرد على المكالمة', call_declined: 'تم رفض المكالمة', call_missed: 'لم يرد أحد', visitor_message: 'رسالة من الزائر',
    door_opened: 'تم فتح الباب', device_offline: 'جرس الباب غير متصل', device_online: 'عاد جرس الباب للاتصال', storage_problem: 'مشكلة في البطاقة',
    firmware_available: 'تحديث البرنامج الثابت متاح', unexpected_reboot: 'إعادة تشغيل غير متوقعة', client_paired: 'تم إقران عميل جديد', user_added: 'تمت إضافة مستخدم',
    user_revoked: 'تم إلغاء مستخدم', login_failed: 'محاولات دخول فاشلة', key_denied: 'تم رفض المفتاح', key_locked: 'تم قفل المفتاح بعد محاولات فاشلة',
    mode_changed: 'تم تغيير الوضع', ring_suppressed: 'تم كتم الجرس بوضع عدم الإزعاج', viewer_joined: 'شخص ما يشاهد الكاميرا', unknown: 'تنبيه',
    mode_failed: 'لم يغيّر جرس الباب الوضع', mode_failed_why: 'لم يغيّر جرس الباب الوضع: {w}',
  },
};

function igEvText(hass, key, vars) {
  const lang = (hass && hass.language) ? hass.language.substring(0, 2) : 'en';
  const table = IG_EV_TEXT[lang] || IG_EV_TEXT.en;
  let s = (table[key] !== undefined) ? table[key] : (IG_EV_TEXT.en[key] !== undefined ? IG_EV_TEXT.en[key] : key);
  if (vars) for (const k of Object.keys(vars)) s = s.replace(`{${k}}`, vars[k]);
  return s;
}


function getLocalText(hass, key) {
  // 1. If no language is configured in HA, we assume English ('en')
  const lang = (hass && hass.language) ? hass.language.substring(0, 2) : 'en';

  // 2. If the detected language does NOT exist in our dictionary, we force English ('en')
  const table = igLocales[lang] || igLocales.en;
  // 3. Fallback PER KEY, not just per language (2026-07-26): before, a key present in 'en'
  //    but forgotten in another language returned `undefined` and literally rendered "undefined" in
  //    the UI. With 15 new keys x 9 languages in this same change (multi-client/quality), the
  //    real risk of someone missing one in the future stops being theoretical - better an
  //    English text than an "undefined" on screen.
  return (table[key] !== undefined) ? table[key] : igLocales.en[key];
}

// ==============================================================================
// FULL SCREEN. Two levels, and the reason there are two isn't
// a defensive "just in case": the browser's real API is NOT available across a
// large part of where this card gets used, and where each case comes from has been checked.
//
// Level 1 - native browser API (Fullscreen API). It's the good one: it also hides the address
// bar/system bars, and gives you ESC-to-exit already handled by the browser.
//
// Level 2 - our own CSS fallback (position:fixed filling the whole viewport). Used where
// level 1 doesn't exist. It does NOT hide the phone's system bars - it fills the whole
// app window, which in the companion app is nearly the whole screen.
//
// WHY LEVEL 2 IS NEEDED, with the two real causes (verified in the source code of
// the projects involved, not guessed from a forum):
//
//   * ANDROID companion app: the web page runs inside a WebView. Chromium only grants the
//     Fullscreen API if the host app implements `WebChromeClient.onShowCustomView`;
//     if it doesn't, `document.fullscreenEnabled` returns false BY DESIGN (chromium:
//     `android_webview/browser/aw_settings.cc` fills `web_prefs->fullscreen_supported` with that
//     data, and Blink reads it in `Fullscreen::FullscreenEnabled`). Home Assistant's
//     Android app didn't implement it: it was added on 2026-05-06 (PR home-assistant/android#6790,
//     `HAWebChromeClient.kt`). In other words, this case is fixed just by updating the app - but
//     whoever has an older version still has no API.
//
//   * iOS companion app: `WKWebView` ships with element fullscreen turned OFF by
//     default; it has to be turned on with `WKPreferences.isElementFullscreenEnabled` (iOS 15.4+).
//     Home Assistant's iOS app doesn't touch it (`WebViewController.swift`,
//     `makeWebViewConfiguration()`), so it stays off. There's no version on our side that
//     fixes this. Also, an iPhone has no element fullscreen in Safari either -
//     it's a WebKit limitation on that form factor, not the app's.
//
// What Advanced Camera Card does (the card the user cites as a reference): it uses the
// `screenfull` library, which does exactly this same detection, and when there's no API it falls
// back to `video.webkitEnterFullscreen()` - iOS's native player. That fallback doesn't work for us:
// it moves the <video> element to a system player and **the card's own buttons**
// **disappear**, which is exactly what this mode has to offer (mic and open door). That's why
// level 2 is our own, in CSS, keeping our HUD.
//
// Design consequence: the fullscreen icon is NEVER a dead icon. There's always a
// real path; only which one changes. See _enterFullscreen().
// ==============================================================================
function nativeFullscreenAvailable() {
  // `document.fullscreenEnabled` is the standard check and covers both whether the engine
  // supports it and whether the context has permission (e.g. an `<iframe>` without `allowfullscreen`
  // returns false, which is the correct answer). The prefixed variant is also checked, for
  // old WebKit browsers.
  const enabled = (document.fullscreenEnabled !== undefined)
    ? document.fullscreenEnabled
    : (document.webkitFullscreenEnabled === true);
  const proto = (typeof Element !== 'undefined') ? Element.prototype : null;
  const canRequest = !!(proto && (proto.requestFullscreen || proto.webkitRequestFullscreen));
  return !!enabled && canRequest;
}

// ⚠️ THE REAL CAUSE OF THE "FULLSCREEN THAT DOESN'T FILL THE SCREEN" (measured 2026-09-25 on the
// living-room tablet, via remote debugging of the Home Assistant app's WebView): the card lives INSIDE
// Home Assistant's Shadow DOM, and `document.fullscreenElement` doesn't return the card but its
// outermost host (<home-assistant>) - that's standard Shadow DOM retargeting. The
// `fsEl === this` comparison was always false, _syncFullscreenFromBrowser() concluded "we're
// not in fullscreen" and undid the mode right after entering it: the browser DID resize
// the card to 1280x800, but without the `.ig-fs` rules the content kept the size it had in the
// panel (732 px tall), leaving a black strip at the bottom. It wasn't the native path's CSS (what
// was assumed in 1.9.2): it was this function. You have to walk down through every `shadowRoot.fullscreenElement`
// until you reach the real element.
function currentFullscreenElement() {
  let el = document.fullscreenElement || document.webkitFullscreenElement || null;
  let guard = 0;
  while (el && el.shadowRoot && el.shadowRoot.fullscreenElement && guard++ < 50) {
    el = el.shadowRoot.fullscreenElement;
  }
  return el;
}

// ==============================================================================
// MULTI-CLIENT / QUALITY (signaling contract 2026-07-26, API_CONTRACT.md §1.4-ter):
// talk turn, client counter and per-recipient quality. All three travel over the
// SAME signaling channel the card already used (local SSE+POST / remote relay WS), with
// no new endpoint or transport - see handleNativeSignal() below.
//
// Quality modes, in the exact order they're rendered in the selector above the video. `wire` is
// the literal value of the JSON `mode` field; `key` is the translation key. `expectsVideo`
// exists for a real, non-cosmetic reason: in 'audio_only' the device does NOT send a single
// video packet to this client, so the life watchdog (which measures progress of
// packetsReceived on the VIDEO INBOUND-RTP) would read that expected silence as a dead
// session and reconnect in a loop every 20s. See _checkLifeWatchdog().
// Each mode ALSO carries an explanatory line (`sub`) rendered under its name in the menu -
// parity with the Android app, and for a specific reason: "Low" is NOT smooth video at lower
// quality, it's ~1 frame per second (the device sends only keyframes, §1.4-ter). Without
// explaining it, a user who turns it on would think the device had broken. For the same reason,
// labels like HD/SD are avoided on purpose: they suggest a RESOLUTION change when what actually
// changes is the FRAME RATE.
const QUALITY_MODES = [
  { wire: 'auto', key: 'q_auto', sub: 'q_auto_sub', icon: 'mdi:auto-fix', expectsVideo: true },
  { wire: 'full', key: 'q_full', sub: 'q_full_sub', icon: 'mdi:video', expectsVideo: true },
  { wire: 'low', key: 'q_low', sub: 'q_low_sub', icon: 'mdi:image-filter-tilt-shift', expectsVideo: true },
  { wire: 'audio_only', key: 'q_audio_only', sub: 'q_audio_only_sub', icon: 'mdi:volume-high', expectsVideo: false },
];

function qualityModeMeta(wire) {
  return QUALITY_MODES.find((m) => m.wire === wire) || null;
}

// Mode chips (2026-07-10, see COORDINATION.md Q22-bis in ig_hassio_addons) - same
// icon per mode as the real Figma mockup (the tint/border of each active mode lives in
// injectStyles(), rules `.chip.active.mode-<key>` - this table only maps each option's LABEL
// to a known icon). The `select.*` entity configured in `mode_entity` is the source
// of truth (real options + current state) - an option that matches no pattern still
// renders (a generic, untinted chip), never hides the whole row.
// `colorVar` (v1.9.5) is the same color the `.chip.active.mode-<key>` rules further
// down already used, now also applied to the dropdown chip (`.mode-pill`/`.mode-opt`) - a single
// place both come from, so they can't drift apart over time (see CLAUDE.md, "defense spread
// across N places").
const MODE_META = {
  normal: { icon: 'mdi:home-outline', colorVar: '--ig-lime' },
  away: { icon: 'mdi:logout', colorVar: '--ig-amber' },
  night: { icon: 'mdi:weather-night', colorVar: '--ig-indigo' },
  custom: { icon: 'mdi:tune', colorVar: '--ig-cyan' }, // mdi:tune-variant doesn't exist in the real Material Design Icons set
};

class IgDoorbellView extends HTMLElement {
  set hass(hass) {
    this._hass = hass;
    // Mode chip / motion chip (2026-07-10, see COORDINATION.md Q22-bis) are read from
    // real, configurable HA entities (mode_entity/motion_entity) - hass gets reassigned on
    // every HA state tick (which can be very frequent), so _updateHassBoundUI() does its
    // own cheap comparison before touching the DOM.
    this._updateHassBoundUI();
  }

  // ⚠️ SINCE 1.10.0 HOME ASSISTANT NO LONGER CREATES THIS ELEMENT (2026-09-26). The card creates it
  // (IgDoorbellCard, below), ONE INSTANCE PER DOORBELL VIEWED: `config` is internal and
  // only carries `device_id` (the one for the doorbell chosen in the selector). The card has no
  // user configuration -- Iñaki's decision: it's configured in ONE place, the integration.
  setConfig(config) {
    if (!config || !config.device_id) {
      throw new Error('ig-doorbell-view: internal config without device_id');
    }
    // Real bug found and fixed (2026-07-10, see COORDINATION.md - user report: when
    // resizing the card's width, the card grows but the video stays the same size
    // as always). Cause: this card does NOT use Shadow DOM (this.innerHTML directly on the
    // element itself, "light" DOM) and the custom element itself (<ig-doorbell-card>) never
    // had its own display/width declared. Autonomous Custom Elements default to
    // `display: inline` unless declared otherwise (neither the browser nor HA does that
    // automatically for you) - an inline element sizes itself to its CONTENT, not to the
    // available width of the container that holds it. All the internal CSS (.ig-container,
    // .video-wrapper, video { width:100% }) WAS correct and relative, but "100%" of an
    // inline element with no width of its own resolves to the content's intrinsic width, not to the
    // space HA gives it (e.g. when resizing the width in a "Sections"-type dashboard). Fixed
    // in JS (not only in the injected stylesheet further below, see injectStyles) so it
    // applies immediately, before any child exists that could depend on it.
    this.style.display = 'block';
    this.style.width = '100%';
    this.style.boxSizing = 'border-box';
    this.config = config;
    // ⚠️ RELEASE THE SCREEN WHEN NOBODY'S WATCHING ANYMORE (2026-09-06, requested by Inaki).
    //
    // While there's video the card requests a wake lock so the screen doesn't dim mid-
    // conversation. On a PHONE that lasts exactly as long as the call. On a WALLPANEL it doesn't: the
    // screen stayed on indefinitely after a ring, and the wake lock also
    // WON against Home Assistant's `command_screen_off`. A snake eating its own tail -- measured on the
    // living-room Galaxy Tab: releasing the stream requires hiding the card, and the wake lock wouldn't
    // let the screen turn off in order to hide it.
    //
    // After `idle_release_seconds` with nobody touching it, the lock gets released. Then the system
    // turns off the screen on its own timeout, the card ends up hidden, and the v1.3.0 fix
    // closes the WebRTC connection. It's restored as soon as someone touches it, so watching or talking is never interrupted.
    //
    // `0` disables it -- for a phone, where this problem doesn't exist and releasing the screen
    // mid-conversation would be a bug, not a saving.
    // ⚠️ SINCE 1.9.0 THIS IS ONLY THE FALLBACK (2026-09-25). The deadline comes from the integration's
    // `number.<doorbell>_live_view_timeout` entity (which an automation can change),
    // see _idleTimeoutMs(). This only applies if the integration is older and doesn't offer it.
    // 120 s, the same default value as the entity (its reasoning is in the integration's number.py).
    // (1.10.0) The YAML `idle_release_seconds` option is gone: the deadline is now set on the
    // integration's entity, which is the only place where this card gets configured.
    this._idleReleaseMs = 120000;
    // The pause (1.9.1): null | { reason: 'hidden'|'idle', phase: 'grace'|'hung_up', micOpen }.
    // 'grace' = live_pause sent, session alive; 'hung_up' = bye, slot released.
    this._pauseState = null;
    this._pauseGraceTimer = null;
    this._idleGraceMs = IDLE_GRACE_MS;
    this._livePauseWanted = false;
    this._livePauseAck = null;
    this._rescueTimers = [];

    // Legacy go2rtc/gateway mode COMPLETELY REMOVED (2026-07-10, explicit decision by the
    // user - see COORDINATION.md in ig_hassio_addons): the project speaks native WebRTC
    // directly with the device/relay, never go2rtc - keeping that dead branch around only added
    // confusion. The only mode supported now: native (the doorbell's own protocol,
    // ICE-Lite+DTLS-SRTP+RTP, via the ig_doorbell integration).

    this.talkActive = false;
    this.pc = null;
    this.nativeSSE = null;
    this._slot = null;

    // ══════════════════════════════════════════════════════════════════════════════════════════
    //  CONNECTION GENERATION (2026-09-07) -- who has the RIGHT to write to this.pc /
    //  this.nativeSSE / this.nativeWS.
    //
    //  The measured bug: the living-room tablet kept piling up connections it never closed. Exact
    //  signature, seen twice and always after a ring -- three connections opened in 0.3 s and only the
    //  LAST one closes at 8 s; the other two were still open 87 minutes later. "Of N simultaneous ones
    //  exactly ONE closes" is the signature of a reentrancy race, not a leak.
    //
    //  Why it happened: startWebRTC() has FIVE call sites and the only guard was
    //  `!this.pc` in four of them (the fifth, render(), had none at all). But `this.pc` isn't
    //  assigned until AFTER two waits -- get_connection_info over HA's WebSocket, and the
    //  TURN credentials, which is an HTTPS request to Germany. During that window `this.pc`
    //  is still `null` and the guard lets everyone through. A single ring fires all three
    //  at once: it wakes the tablet (visibilitychange), the wallpanel navigates to the view (render), and
    //  HA re-inserts the element (connectedCallback).
    //
    //  And _teardownConnectionObjects() can only close what's IN this.*, i.e. the last
    //  assignment. The earlier invocations were left orphaned: their WebSocket never closed,
    //  and each one holds on to one of the FOUR WebRTC slots the doorbell has for the whole
    //  house.
    //
    //  ⚠️ THE FIX IS NOT A BETTER GUARD IN THE FIVE PLACES, AND THAT'S WHAT MATTERS. A
    //  defense spread across N call sites collapses entirely the moment ONE falls behind -- which
    //  is literally what had already happened here (four with `!this.pc`, one bare). The
    //  guard lives INSIDE startWebRTC(), where no new call site can skip it
    //  by mistake.
    //
    //  Two pieces, and both are needed:
    //
    //   · `_connGen` -- goes up on EVERY _teardownConnectionObjects(). An in-flight invocation compares
    //     its generation against this one before publishing anything to `this.*`; if it doesn't match,
    //     it CLOSES ITS OWN and leaves silently instead of abandoning it. This is what collects the garbage.
    //   · `_startInFlightGen` -- the generation of the startWebRTC() currently in progress, or `null`.
    //     This is what avoids GENERATING one: while there's one in flight AND it's still the current one,
    //     subsequent triggers get discarded instead of opening a second connection.
    //
    //  That the guard only blocks while the in-flight one IS STILL THE CURRENT ONE isn't a detail:
    //  it's what lets a legitimate reconnection through. _scheduleReconnect() tears down (bumping the
    //  generation) and starts again 2 s later -- if the guard only looked at "there's one in flight",
    //  it would eat that reconnection and the card would be left staring at a corpse.
    // ══════════════════════════════════════════════════════════════════════════════════════════
    this._connGen = 0;
    this._startInFlightGen = null;
    this._startInFlightAt = 0;
    this.localAudioStream = null;
    this.dummyAudioTrack = null;

    // "Life signal" watchdog + automatic reconnection (2026-07-10, see COORDINATION.md
    // Q19 - symmetric design with the firmware's own abandonment timeout, lowered from 45s to
    // 20s). Only applies to native mode, see _startLifeWatchdog()/_checkLifeWatchdog() below.
    this._watchdogTimer = null;
    this._reconnectTimer = null;
    this._reconnectAttempt = 0;
    this._reconnecting = false;
    this._lastLifeSignalAt = null;
    this._prevPacketsReceived = null;

    // ---- Multi-client / quality (2026-07-26, API_CONTRACT.md §1.4-ter) ----------------------
    // All of this also gets reset in _resetMulticlientState() on every teardown/new session: the
    // talk turn and quality are PER-SESSION state on the device (a new session
    // always starts in 'full' and with no turn), so the card must not inherit anything from the previous one.
    this._talkHeld = false;       // the device granted us the turn (talk_granted)
    this._talkPending = false;    // a talk_request is in flight
    this._talkTimer = null;
    this._talkGrantedAt = 0;      // for the anti-race-revocation grace period, see _reconcileTalkTurn
    this._talkUnsupported = false; // firmware predating the contract: doesn't reply to talk_request
    this._listenOnly = false;     // turn denied: the doorbell can be heard but the mic stays closed
    this._talkFreeHintShown = false; // "channel free" was already reported during this particular wait
    this._talkerSlot = -1;        // slot that holds the turn according to the device (-1 = free)
    this._clients = null;         // null = the device never sent session_info (old firmware)
    this._quality = 'auto';       // mode requested by this card
    this._qualityEffective = null; // mode CONFIRMED by the device (sole source of truth)
    this._qualitySupported = null; // null = not confirmed yet; false = firmware without quality support
    this._qualityProbeTimer = null;
    this._qualityProbeAttempts = 0;
    this._qualityMenuOpen = false;

    // ---- Full screen (2026-07-29) -----------------------------------------------------
    // Unlike the block above, this is NOT per-session state: it's a user display
    // preference and survives a reconnection (it would be absurd for a two-second
    // network drop to kick you out of fullscreen while you're talking to whoever's at the
    // door). That's why it's not touched in _resetMulticlientState().
    this._fsActive = false;
    this._fsNative = false;      // true = real browser fullscreen; false = CSS fallback
    this._fsUnavailable = false; // neither native API nor a usable fallback: the icon hides itself
    this._wakeLock = null;

    // Doorbell lock type: 0 = physical relay, 1 = Home Assistant entity, 2 = none.
    // With 2, the open button must NOT be drawn, instead of being drawn and failing.
    //
    // The data arrives on EVERY `session_info` (2026-07-29), not just the first one, and that allows
    // two things: if a notification gets lost -- they're dropped when the outgoing queue is full --
    // the next one rebuilds the data; and if someone changes the lock type from the doorbell's
    // dashboard while this card is open, it's reflected within <=4s instead of dragging a wrong
    // button along until the next reconnection.
    //
    // `null` = it hasn't said yet (or older firmware, which doesn't send the field). In that case, and
    // ONLY in that case, the safety net of learning it by failing still applies: see
    // _noLockLegacy and handleNativeOpenResult(). A received `door_m` always overrides it.
    this._doorMode = null;
    this._noLockLegacy = false;

    // ---- Double-tap to open (API_CONTRACT.md §1.8, 2026-07-30) ----------------------
    // Not configurable on purpose (the contract says so): a safety mechanism that can be
    // disabled stops being one.
    this._doorArmedAt = 0;
    this._doorArmTimer = null;

    // ---- Client sound (API_CONTRACT.md §1.10, 2026-07-30) -----------------------------
    // WATCHING ISN'T LISTENING: the speaker on THIS side starts MUTED and only plays sound for an
    // explicit reason (the user opens it, or someone rings the bell). A wallpanel that shows the
    // street 24/7 can't pipe the street's noise into the house 24/7.
    //
    // The doorbell isn't asked to stop sending audio (that would be `quality`, §1.4-ter, and would save
    // ~24 kbps which, next to video, is statistical noise): it simply isn't played.
    this._audioOn = false;
    this._audioOnBeforeMic = false;  // to restore the sound to how it was when the mic closes
    this._ringMarker = null;         // last state read from ring_entity (null = not read yet)

    // ---- Image rotation (API_CONTRACT.md §1.9, 2026-07-30) -------------------------------
    // The camera module is mounted ROTATED 90° inside the housing, on purpose: in portrait it
    // fits a whole person plus a package on the ground. Rotating it on the doorbell itself measured
    // 65-71 ms per frame, against a total 15 fps budget of 66.7 ms - not viable. So the
    // frame travels in landscape with the scene rotated inside it and EACH CLIENT straightens it out
    // when rendering, which is free on any platform.
    //
    // The data arrives in `rot` inside EVERY `session_info` (§1.4-ter), like `door_m`.
    //
    // The last known value for THIS doorbell is remembered (localStorage) so it doesn't reserve
    // the wrong space and visibly jump shape on every startup, which is the bug Iñaki
    // saw on iOS. The first time, with no stored data, it reserves PORTRAIT: that's the product's
    // mounting, and defaulting to the rare case is better than defaulting wrong every time.
    this._rot = this._recallRotation();
    this._rotConfirmed = false;

    // ---- Side rail: hysteresis (Iñaki, 2026-09-08) -------------------------------------
    // The ground truth of whether the rail is active RIGHT NOW - it has to be stored because the
    // entry rule and the exit rule use DIFFERENT thresholds (see _layoutRotation): without knowing
    // which side you're on, there's no way to know which of the two applies.
    this._railActive = false;

    this.render();
  }

  // (1.11.0) Masonry places cards by this number (1 unit = 50 px). It said 4 (200 px) for a card
  // that measures 700-1000 px, so Masonry packed other cards as if it were small.
  getCardSize() { return cardSizeFromHeight(this.offsetHeight); }

  connectedCallback() {
    if (this._destroyed) return;  // (1.10.0) instance of a doorbell that's no longer being viewed: see _destroy()
    // The SAME element that was removed comes back into view (Home Assistant reuses its views): the
    // "off-screen" pause resumes. The idle one does NOT: that one is a person's.
    if (this._pauseState && this._pauseState.reason === 'hidden') {
      this._registerVisibilityStreamHandler();
      this._registerOffscreenStreamHandler();
      this._registerUnloadHandler();
      this._resume('the card is back in the DOM');
      if (this.content) this._registerFullscreenListeners();
      return;
    }
    if (this.content) this._registerFullscreenListeners();
    if (this.content) this._registerFitObservers();
    this._registerVisibilityStreamHandler();
    this._registerOffscreenStreamHandler();
    if (this.content && !this.pc && !this._restoreSavedPause()) this.startWebRTC('connectedCallback');
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════
  //  RELEASE THE STREAM WHEN HIDDEN (2026-09-06)
  //
  //  disconnectedCallback() already tore down the connection and released the wake lock. The problem
  //  wasn't that this code was missing: it was that NOBODY CALLED IT in the cases that matter. Measured
  //  on the living-room tablet (Galaxy Tab, wallpanel) by the home HASS session:
  //
  //    · navigating to another Lovelace view does NOT cut the WebRTC connection -- the SPA doesn't
  //      remove the card from the DOM, so disconnectedCallback() never fires;
  //    · `command_webview` to about:blank doesn't cut it either;
  //    · every navigation OPENS a new connection without closing the previous one (viewers 1 -> 3);
  //    · the only thing that cut it was `am force-stop` on the Home Assistant app.
  //
  //  Real consequence: the tablet was left with the screen on and consuming video
  //  INDEFINITELY, because the stream holds the brightness wakelock. And it also ate up the
  //  doorbell's slots, of which there are only 4 for the whole house.
  //
  //  `visibilitychange` covers TWO of those three cases: screen off and app in the background. Watch out --
  //  it is NOT the same handler as `_onVisibilityForWakeLock`: that one only RESTORES the wake lock
  //  on becoming visible again, and does nothing on hiding, which is exactly the missing half.
  //
  //  ⚠️ AND HERE THERE USED TO BE A LIE, FIXED ON 2026-09-07. This very comment used to say
  //  that `visibilitychange` also fires "when the view stops being in front", and therefore that
  //  the FIRST case in the list above -- navigating to another Lovelace view -- was covered.
  //  That's false: `document.visibilityState` belongs to the DOCUMENT, and a single-page app
  //  that swaps views doesn't change its document's visibility. The event never fires.
  //
  //  In other words, the case that HEADED the list of measured symptoms was the one this handler
  //  didn't cover, and the comment claimed the opposite. It's the worst of the failure families
  //  CLAUDE.md warns about: not a missing defense, but one believed to be in place -- whoever came
  //  to fix that symptom would read here that it was already solved and would look elsewhere.
  //
  //  It's now covered by _registerOffscreenStreamHandler() (below), with an IntersectionObserver.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  _registerVisibilityStreamHandler() {
    if (this._onVisibilityForStream) return;
    // ⚠️ IÑAKI'S RULE (2026-09-25), FOR ALL CLIENTS: «It doesn't matter whether there's a call or not. When
    // the live view is abandoned, the stream stops and resumes when you come back, in the same
    // state it was in when you left.» Until 1.9.0, hiding TORE DOWN the session (and with it the
    // mic and the turn). Now it's `live_pause` (the doorbell stops sending media instantly) and on
    // returning, `live_resume` with the mic/turn as they were. With no call, after the grace period it hangs up
    // and the slot is released; with a call it doesn't hang up (the session is the call).
    this._onVisibilityForStream = () => {
      if (document.visibilityState === 'hidden') {
        this._pause('hidden');
      } else if (document.visibilityState === 'visible' && this._pauseState && this._pauseState.reason === 'hidden') {
        this._resume('became visible again');
      }
    };
    document.addEventListener('visibilitychange', this._onVisibilityForStream);
  }

  _unregisterVisibilityStreamHandler() {
    if (!this._onVisibilityForStream) return;
    document.removeEventListener('visibilitychange', this._onVisibilityForStream);
    this._onVisibilityForStream = null;
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════
  //  THE CARD STOPS BEING ON SCREEN WITHOUT LEAVING THE DOM (2026-09-07)
  //
  //  Covers the case `visibilitychange` CANNOT cover: navigating to another Lovelace view. Home
  //  Assistant is a single-page application, so it neither removes the card from the DOM
  //  (disconnectedCallback never fires) nor changes the document's visibility. The two
  //  mechanisms that existed watched exactly those two things, and that's why the symptom measured on
  //  the living-room tablet -- «every navigation OPENS a new connection without closing the previous one,
  //  viewers 1 -> 3» -- was still alive.
  //
  //  An IntersectionObserver answers the right question, which isn't "are you still in the tree" nor
  //  "is the tab in front", but **is anyone actually looking at you**. A hidden Lovelace view leaves its
  //  cards with no visible area, and the observer sees that without knowing anything about Home
  //  Assistant's internals -- which is what keeps this from breaking with the frontend's next version.
  //
  //  ⚠️ TWO GUARDS AGAINST FALSE TRIGGERS, AND THEY'RE WHAT MATTERS ABOUT THIS FUNCTION. Cutting the
  //  video of someone who's actually watching is worse than any wasted slot:
  //
  //   1. **Minimum margin (1.9.1: 1.5 s; until 1.9.0 it was 30 s).** Leaving the view no longer
  //      tears down anything: it's `live_pause`, and coming back is `live_resume` in < 1 s, so waiting 30 s
  //      only served to send video to nobody (Iñaki's rule from 2026-09-25: off-screen, pause
  //      immediately). The margin avoids pausing on a layout flicker.
  //   2. **Never while in fullscreen.** _portalToBody() moves the CONTAINER to <body> when an
  //      ancestor traps `position:fixed`, and then the card's own element is left with no
  //      area -- i.e. the observer would say "not visible" while the video fills the whole screen.
  //      Without this line, watching in fullscreen for more than 30 s would cut the video by itself.
  //
  //  ⚠️ REASONED, NOT MEASURED (2026-09-07): this was written without an actual doorbell in front of it and
  //  without a wallpanel running real Home Assistant. What IS measured is the SYMPTOM (the home HASS
  //  session, with `dumpsys`), not that this remedy fixes it. If someone verifies it, they should delete this note and
  //  write down what they saw.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  _registerOffscreenStreamHandler() {
    if (this._offscreenObserver || typeof IntersectionObserver === 'undefined') return;
    this._offscreenObserver = new IntersectionObserver((entries) => {
      const visible = entries.some((e) => e.isIntersecting);
      this._offscreenVisible = visible;
      if (visible) {
        this._clearOffscreenTimer();
        // Only lifts the "off-screen" pause. The idle one belongs to a person or to
        // a ring: a layout flicker (the sourceless <video> changing size) is NOT
        // someone coming back, and treating it as such was the loop measured on the tablet (1.9.0).
        if (this._pauseState && this._pauseState.reason === 'hidden' && document.visibilityState === 'visible') this._resume('the card is on screen again');
        return;
      }
      if (this._offscreenTimer) return;               // a countdown is already running
      // 1.5 s and not 30 as until 1.9.0: pausing no longer tears anything down (live_pause) and coming
      // back is < 1 s, so waiting only served to keep sending video to nobody. A minimum margin
      // is kept so a layout flicker doesn't pause and resume for no reason.
      this._offscreenTimer = setTimeout(() => {
        this._offscreenTimer = null;
        if (this._fsActive) return;                   // in fullscreen the observer lies
        // Entering or leaving fullscreen (1.9.3): the card gets repositioned and for an instant the
        // observer may say «out». If by the time the deadline expires it's visible again, or the transition
        // just happened, it's not leaving the view.
        if (this._offscreenVisible) return;
        if (this._fsTransitionUntil && Date.now() < this._fsTransitionUntil) return;
        console.info('[ig-doorbell-card] the card has left the view: live_pause');
        this._pause('hidden');
      }, OFFSCREEN_PAUSE_MS);
    });
    this._offscreenObserver.observe(this);
  }

  _clearOffscreenTimer() {
    if (this._offscreenTimer) { clearTimeout(this._offscreenTimer); this._offscreenTimer = null; }
  }

  _unregisterOffscreenStreamHandler() {
    this._clearOffscreenTimer();
    if (!this._offscreenObserver) return;
    this._offscreenObserver.disconnect();
    this._offscreenObserver = null;
  }

  disconnectedCallback() {
    // ⚠️ LEAVING THE VIEW MEANS PAUSING, NOT TEARING DOWN (1.9.1, Iñaki's rule from 2026-09-25). Measured on
    // Home Assistant 2026.9.3: switching Lovelace views REMOVES the card from the DOM. Until 1.9.0 that
    // tore down the session (and the mic, and the turn). Now it's the same pause as hiding:
    // `live_pause` right away, `bye` after the grace period if there's no call; and if Home Assistant re-inserts
    // this same element, connectedCallback() resumes it in the same state. If it never re-inserts it,
    // the grace period hangs up anyway (and with a call, the CALL_HIDDEN_MAX_MS cap).
    // (1.10.0) An instance destroyed by a doorbell change has already hung up and released everything: the
    // card being removed from the DOM afterwards can't pause anything again (and it would mark the
    // old doorbell's pause in PAUSED_BY_DOORBELL, which is module-level).
    if (this._destroyed) return;
    this._pause('hidden');                     // leaving the DOM = pausing, not tearing down
    this._releaseListeners();
  }

  // Everything this instance hangs OUTSIDE of itself (document, window, observers,
  // UI timers, fullscreen, wake lock). Shared by disconnectedCallback()
  // and _destroy() -- extracted in 1.10.0 so neither one can forget about one of them.
  _releaseListeners() {
    this._unregisterFitObservers();
    this._unregisterUnloadHandler();
    this._unregisterVisibilityStreamHandler();
    this._unregisterOffscreenStreamHandler();
    this._unregisterIdleActivityListeners();
    this._clearIdleWakeLockTimer();
    if (this.micButton) {
      this._setLiveState('connecting');
    }
    if (this.loader) this.loader.style.opacity = '1';
    if (this._doorArmTimer) { clearTimeout(this._doorArmTimer); this._doorArmTimer = null; }
    this._doorArmedAt = 0;
    this._stopRetryCountdown();
    if (this._doorWaitTimer) { clearTimeout(this._doorWaitTimer); this._doorWaitTimer = null; }
    if (this._doorCountdownTimer) { clearInterval(this._doorCountdownTimer); this._doorCountdownTimer = null; }
    if (this._feedRO) { this._feedRO.disconnect(); this._feedRO = null; }
    if (this._onWindowResizeForRot) {
      window.removeEventListener('resize', this._onWindowResizeForRot);
      this._onWindowResizeForRot = null;
    }
    if (this._onDocClickForQuality) {
      document.removeEventListener('click', this._onDocClickForQuality);
      this._onDocClickForQuality = null;
    }
    if (this._onDocClickForModeMenu) {
      document.removeEventListener('click', this._onDocClickForModeMenu);
      this._onDocClickForModeMenu = null;
    }
    // Fullscreen: ALWAYS exit when the card disappears from the DOM (Lovelace view change,
    // editing the dashboard...). Without this, the CSS fallback would leave the document's
    // `scroll` locked and the user would be left with a dashboard that doesn't move, with no
    // visible card to blame; and the wake lock would stay alive draining the battery.
    if (this._fsActive) this._exitFullscreen();
    this._releaseWakeLock();
    document.body.classList.remove('ig-fs-body-lock');
    if (this._onFsChange) {
      document.removeEventListener('fullscreenchange', this._onFsChange);
      document.removeEventListener('webkitfullscreenchange', this._onFsChange);
      this._onFsChange = null;
    }
    if (this._onFsKeyDown) {
      document.removeEventListener('keydown', this._onFsKeyDown);
      this._onFsKeyDown = null;
    }
  }

  // ==============================================================================
  // Shared cleanup of the native connection (2026-07-10, see COORDINATION.md Q18/Q19).
  // Closes pc/nativeSSE/nativeWS, sends 'bye' before closing when applicable, resets the slot and
  // stops the life watchdog - used both by disconnectedCallback() (the card leaves the DOM)
  // and by _scheduleReconnect() (the session was declared dead and needs reconnecting). Extracted
  // into a single place so the closing logic isn't duplicated between the two cases.
  // ==============================================================================
  _teardownConnectionObjects() {
    // ⚠️ BUMPING THE GENERATION IS PART OF TEARDOWN, NOT DECORATION (2026-09-07 -- see the CONNECTION
    // GENERATION block in the constructor).
    //
    // This function closes what's IN `this.*`. What it can't close is what doesn't yet
    // exist: a startWebRTC() halfway through, waiting on TURN credentials, that within a second
    // will create an RTCPeerConnection and a WebSocket and write them right here on top. That's the orphan.
    //
    // Putting the counter HERE, and not in startWebRTC(), is what makes the invalidation impossible
    // to forget: the FIVE places that tear down (leaving the DOM, hiding, the idle
    // wait, reconnecting, and startup itself) all go through this line. A new teardown site
    // inherits the invalidation without having to remember anything -- which is exactly the
    // "defense spread across N places" failure family that already claimed `!this.pc`.
    this._connGen += 1;
    this._stopLifeWatchdog();
    this._stopAudioSendDiagnostics();
    // If the mic was open, the sound was turned on BY THE MIC - when it closes it has to be
    // restored to how it was before (§1.10). It's computed up here because _resetMulticlientState()
    // (below) clears _listenOnly.
    const micWasOpen = this.talkActive || this._listenOnly;
    // Real bug found and fixed (2026-07-10, see COORDINATION.md - user's suspicion
    // about the audio return channel): this function is the ONLY shared teardown point
    // used by disconnectedCallback(), startWebRTC() and _scheduleReconnect() - but until now it
    // only closed pc/nativeSSE/nativeWS, without touching the intercom's state. Real effect: if the mic
    // was active (replaceTrack() had already put the real microphone track on the sender) and
    // a reconnection happened (e.g. the aggressive 'disconnected'->reconnect shortcut further below,
    // which can fire from a transient ICE glitch with no action from the user), the new
    // RTCPeerConnection is built from scratch with a new MUTED track (buildNativePeerConnection())
    // - but since talkActive/the button's classes were never reset here, the UI kept
    // showing "mic active" (red icon, 'Comms Open' badge) indefinitely even though the real
    // outgoing audio had gone back to silence, with toggleTalk() never being called again
    // to reattach the real microphone to the new sender. It also left the browser's microphone
    // device marked "in use" (OS icon) with no real use behind it. This is closed by centralizing
    // the reset here: any teardown (voluntary or due to reconnection) stops the real stream and returns
    // the button to the "off" state - a subsequent successful reconnect doesn't reactivate the mic on its own (the
    // user has to press it again, just like the first time - explicit behavior, not
    // silent).
    if (this.localAudioStream) {
      this.localAudioStream.getTracks().forEach((track) => track.stop());
      this.localAudioStream = null;
    }
    this.talkActive = false;
    // Talk turn / counter / quality: PER-SESSION state, never inherited (2026-07-26,
    // §1.4-ter). Goes BEFORE repainting the button so _paintMicState() already sees the clean state.
    this._resetMulticlientState();
    if (micWasOpen) this._setAudioOn(this._audioOnBeforeMic, 'teardown');
    if (this.micButton) {
      this.micButton.setAttribute('disabled', '');
      this._paintMicState();
    }
    if (this.audioPill) this.audioPill.style.display = 'none';
    this._updateMotionPill(); // the "never with the mic active" rule no longer applies after this reset
    this._disarmDoorConfirm();     // a half-finished confirmation doesn't survive a session drop
    this._clearDoorWait(); // nor an "Opening..." from a session that no longer exists
    if (this.unlockButton) {
      this.unlockButton.classList.remove('active-unlock');
      this.unlockButton.setAttribute('disabled', '');
      if (this.unlockIcon) this.unlockIcon.setAttribute('icon', 'mdi:lock-open-variant');
      this._setDoorLabel(false);
    }
    if (this._doorCountdownTimer) { clearInterval(this._doorCountdownTimer); this._doorCountdownTimer = null; }
    this._resetStatusLine();
    if (this.pc) { this._closePeerConnection(this.pc); this.pc = null; }
    if (this.nativeSSE) {
      // Fixed (2026-07-10, see COORDINATION.md): sending 'bye' here for the local path
      // before closing was missing - only the remote path (below) did it, so switching
      // Lovelace views (or reconnecting) with an active local session left the slot occupied
      // until the doorbell's abandonment timeout instead of releasing instantly. A normal
      // fetch() is enough here (unlike _sendByeOnUnload/pagehide) because the page itself
      // stays alive.
      try { this.sendNativeSignal({ type: 'bye' }); } catch (err) { /* best effort */ }
      this.nativeSSE.close();
      this.nativeSSE = null;
    }
    this._slot = null;
  }

  // Closes an RTCPeerConnection AND the AudioContext that buildNativePeerConnection() created to
  // hang the muted outgoing track off of. It exists as a separate function because there are TWO places
  // that close a `pc`: the teardown above (the current `pc`) and the relay path of
  // startNativeSession() (a `pc` that was born ahead of time and never got published). The second one has
  // no `this.*` to look at, so the cleanup has to be attached to the object itself.
  //
  // The AudioContext was NEVER closed until today. With a single session it goes unnoticed; with a
  // wallpanel's reconnection loop that's dozens of live audio contexts, and Chrome has a
  // hard cap per tab (~6 on older versions, higher today but still finite): past that cap
  // `new AudioContext()` throws and the card is left without an outgoing track -- i.e. no microphone,
  // which would be read as an intercom failure, not a reconnection leak.
  _closePeerConnection(pc) {
    if (!pc) return;
    try { pc.close(); } catch (err) { /* best effort */ }
    if (pc.__igAudioCtx) {
      try { pc.__igAudioCtx.close(); } catch (err) { /* best effort */ }
      pc.__igAudioCtx = null;
    }
  }

  // ==============================================================================
  // LIFE-SIGNAL WATCHDOG + AUTOMATIC RECONNECTION (2026-07-10, see COORDINATION.md Q19).
  // Symmetric design with the firmware, which lowers its own abandonment timeout from 45s to 20s: the
  // consumer side (this card) also has to stop waiting passively and act if the session
  // has gone ~20s with no real life signal.
  //
  // Primary signal: real progress in getStats() on the video track (packetsReceived climbing) -
  // not the browser's ICE state, which is governed by its own "consent
  // freshness" checks (RFC 7675) and can keep saying "connected" even though the video stopped for
  // some other reason (e.g. a server-side hang); it also isn't tunable to the exact 20s the
  // design calls for, it varies by browser. getStats() measures exactly what matters and gives full control
  // over the threshold. Secondary signal, for the negotiation phase BEFORE there's any video: any
  // signaling message received (offer/candidate/heartbeat) also counts as life - see
  // _recordLifeSignal() called from tryLocalSignaling()/startRelaySignaling().
  //
  // AGGRESSIVE shortcut (user decision 2026-07-10, same criterion android_app uses in its own
  // watchdog): both 'failed' AND 'disconnected' on pc.onconnectionstatechange trigger
  // immediate reconnection without waiting out the rest of the 20s clock - knowingly, since
  // 'disconnected' can be transient and this could interrupt some normal recovery
  // every now and then; the user wants to validate it live against his own poor 4G/5G coverage. The
  // getStats() check further down remains as a fallback for the case that shortcut does NOT cover:
  // "transport apparently healthy but no real data arriving" (connectionState stays
  // 'connected' but the video stopped).
  // ==============================================================================
  _startLifeWatchdog() {
    this._stopLifeWatchdog();
    this._prevPacketsReceived = null;
    this._recordLifeSignal(); // starts the clock from now, not from "never"
    this._watchdogTimer = setInterval(() => this._checkLifeWatchdog(), 5000);
  }

  _stopLifeWatchdog() {
    if (this._watchdogTimer) {
      clearInterval(this._watchdogTimer);
      this._watchdogTimer = null;
    }
  }

  _recordLifeSignal() {
    this._lastLifeSignalAt = performance.now();
  }

  async _checkLifeWatchdog() {
    if (!this.pc) return;
    // Contract rule 2: a session THIS CLIENT wants paused is alive by definition.
    if (this._livePauseWanted) { this._recordLifeSignal(); return; }

    try {
      const stats = await this.pc.getStats();
      // With 'audio_only' quality (§1.4-ter #3) the device does NOT send a single video packet to
      // this client ON PURPOSE - measuring video there would make this watchdog interpret an
      // expected silence as a dead session and reconnect in a loop every 20s, breaking exactly the
      // feature the user just asked for. In that mode (and only that one) the life signal is the
      // audio, which keeps flowing intact. In 'low' (~1 fps) the video keeps progressing plenty
      // between 5s checks, so it needs no special treatment.
      const effectiveMeta = qualityModeMeta(this._qualityEffective || this._quality);
      const watchKind = (effectiveMeta && !effectiveMeta.expectsVideo) ? 'audio' : 'video';
      let packetsReceived = null;
      stats.forEach((report) => {
        if (report.type === 'inbound-rtp' && report.kind === watchKind) {
          packetsReceived = (typeof report.packetsReceived === 'number')
            ? report.packetsReceived
            : (typeof report.framesReceived === 'number' ? report.framesReceived : null);
        }
      });
      if (packetsReceived !== null) {
        if (this._prevPacketsReceived === null || packetsReceived > this._prevPacketsReceived) {
          this._framesSeen = (this._framesSeen || 0) + 1;
          this._recordLifeSignal();
          this._confirmLiveFromMedia();
        }
        this._prevPacketsReceived = packetsReceived;
      }
    } catch (err) {
      // Non-blocking - getStats() shouldn't fail under normal circumstances; if it fails, it
      // keeps trusting whatever last timestamp it already had (e.g. from signaling).
      console.warn('[ig-doorbell-card] getStats() failed during the life watchdog', err);
    }

    if (this._lastLifeSignalAt !== null && (performance.now() - this._lastLifeSignalAt) >= 20000) {
      this._scheduleReconnect('20s with no real life signals (no getStats progress / no signaling)');
    }
  }

  _clearReconnectTimer() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  // Single reconnection point, used by: the 20s watchdog, the connectionState
  // failed/disconnected shortcut, and a 'bye' received from the device itself (e.g. displaced by another
  // session). Reuses startWebRTC() (the same entry point as the initial connection) instead
  // of duplicating the connection logic - it retries local-first-then-remote from scratch,
  // which makes sense since network conditions may have changed.
  //
  // `gen` is OPTIONAL on purpose: triggers that aren't born from a specific startup (the
  // life watchdog, a received `bye`) have no generation of their own to cite and must always be able to
  // reconnect. The ones that DO come from one -- the handlers of a specific `pc` or WebSocket --
  // pass it, and then a trigger from a session that's already been superseded gets discarded: without this,
  // the dying `pc` of an early startup would take down the good startup's session when it closes.
  _scheduleReconnect(reason, gen) {
    if (this._destroyed) return;  // (1.10.0) instance of a doorbell that's no longer being viewed: see _destroy()
    if (gen !== undefined && this._superseded(gen)) return;
    // While paused there's no reconnecting: if a session in grace drops, it's considered hung up.
    if (this._pauseState) { if (this._pauseState.phase === 'grace') this._hangUpPaused(); return; }
    if (this._reconnecting) return;
    this._reconnecting = true;

    console.warn(`[ig-doorbell-card] native session lost (${reason}) - reconnecting...`);
    this._mark(`_scheduleReconnect: ${reason}`);
    this._teardownConnectionObjects();

    this._setLiveState('connecting');
    if (this.loader) this.loader.style.opacity = '1';

    this._reconnectAttempt += 1;
    // Simple backoff: 2s, 4s, 8s, capped at 15s. Indefinite retries on purpose (user's
    // decision, this is a home security product) - _reconnectAttempt resets to 0 as soon as a
    // reconnect actually brings video back, see setupRemoteStream().
    const backoffMs = Math.min(2000 * Math.pow(2, this._reconnectAttempt - 1), 15000);
    this._mark(`_scheduleReconnect: retry #${this._reconnectAttempt} in ${backoffMs}ms`);
    // §1.0: the loading spinner starts spinning again here, and until now it spun WITHOUT SAYING ANYTHING. An
    // indicator that spins indefinitely with no explanation is worse than having none: the user
    // doesn't know whether to wait or whether the card is broken. With the countdown visible, spinning stops
    // being ambiguous - you can see there's a plan and when the next attempt is due.
    this._startRetryCountdown(backoffMs);

    this._clearReconnectTimer();
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._reconnecting = false;
      this.startWebRTC(`_scheduleReconnect: ${reason}`);
    }, backoffMs);
  }

  // ==============================================================================
  // HASS-BOUND VISUAL STATE (2026-07-10, see COORDINATION.md Q22-bis) - mode chip and
  // motion chip, both optional (they only appear if the user configures the corresponding
  // entity). `set hass()` calls here on every HA state tick (potentially very
  // frequent) - each sub-method does its own cheap comparison before touching the DOM.
  // ==============================================================================
  _updateHassBoundUI() {
    if (!this.content) return;
    this._updateModeRow();
    this._updateMotionPill();
    this._updateRingState();
    this._updateRecButton();
    this._updateRecordingsButton();
    this._updateQuickReplyButton();
    this._updateBell();
    this._watchIdleTimeout();
    this._repaintTextsIfLanguageChanged();
  }

  // Language: repaint the texts that only get written ONCE (2026-07-29, found by measuring with
  // Playwright, not by reasoning about it). Home Assistant ALWAYS calls setConfig() before assigning `hass`
  // - and it's setConfig() that calls render(). So the card's entire initial HTML gets painted
  // with `this._hass` still undefined, and getLocalText() falls back to English no matter what, even
  // for a user with Home Assistant in Spanish. Most texts got saved incidentally
  // because something repaints them on connection (the badge, the button labels, the status
  // line); the ones that don't depend on state - the fullscreen button's title, the
  // client counter's, the quality menu - stayed in English forever, silently.
  // The effectively-painted language is compared so nothing is redone on every HA state tick,
  // which can be very frequent.
  _repaintTextsIfLanguageChanged() {
    const lang = (this._hass && this._hass.language) ? this._hass.language.substring(0, 2) : 'en';
    if (this._paintedLang === lang) return;
    this._paintedLang = lang;
    this._paintFullscreenButton();
    if (this.clientsPill) this.clientsPill.setAttribute('title', getLocalText(this._hass, 'clients_tip'));
    if (this.qualityBtn) this.qualityBtn.setAttribute('title', getLocalText(this._hass, 'q_label'));
    if (this.qualityMenu) { this._renderQualityMenu(); this._paintQuality(); }
    // The two pills over the video are in the initial HTML and nobody ever repaints them: they're
    // fixed text, only shown and hidden. Without this they stayed in English just like the rest
    // - and "Audio active" over the video is one of the most visible things this card has.
    const audioTxt = this.audioPill && this.audioPill.querySelector('span');
    if (audioTxt) audioTxt.textContent = getLocalText(this._hass, 'audio_active');
    const motionTxt = this.motionPill && this.motionPill.querySelector('span');
    if (motionTxt) motionTxt.textContent = getLocalText(this._hass, 'motion_detected');
    this._paintAudioState(); // the speaker control's title also gets written only once
    // (1.9.7) The mic/door and Recordings labels were also only written in render():
    // mic and door got saved on a state change, Recordings never did.
    if (this.micLabel) this._paintMicState();
    if (this.unlockLabel && !this.unlockLabel.classList.contains('on-green')) this._setDoorLabel(false);
    const recLbl = this.recordingsButton && this.recordingsButton.querySelector('.quick-btn-label');
    if (recLbl) recLbl.textContent = getLocalText(this._hass, 'recordings_title');
    // Quick reply (v1.9.8): same pattern as Recordings just above.
    const qrLbl = this.qrButton && this.qrButton.querySelector('.quick-btn-label');
    if (qrLbl) qrLbl.textContent = getLocalText(this._hass, 'quick_reply_title');
    if (this._bellBtn) this._paintBell();
    this._lastPickerSig = null; this._paintPicker();
    if (this._evOpen) this._renderEvents();
    if (this._qrOpen) this._renderQuickReplies();
    // The status badge and bottom line repaint themselves as soon as the session changes
    // state, so they almost always fixed themselves. Almost: a card that NEVER manages to
    // connect - the doorbell off, or away from home with no coverage - is left with the
    // initial "Connecting..." in English indefinitely, which is exactly the moment the
    // user looks at that text the most. They're repainted with the state that's already there, without changing it.
    if (this._liveStateKey || this.badge) this._setLiveState(this._liveStateKey || 'connecting');
    // The status line only if it's idle: a notice already in progress ("Door open · Closing
    // in Ns", "channel busy") must not be erased just because Home Assistant sent a tick.
    if (this.statusLine && !this.statusLine.classList.contains('open') && !this.statusLine.classList.contains('warn')) {
      this._resetStatusLine();
    }
  }

  // ==============================================================================
  // THE DOORBELL'S OWN ENTITIES, WITH NO CONFIGURATION AT ALL (1.9.3, Iñaki 2026-09-25: «I don't see
  // the chip to record or to change the mode in the card»). Until 1.9.2 the mode chips and the REC button
  // only appeared if the panel's YAML included `mode_entity`/`rec_entity` - and no real panel
  // included them, so both features existed and nobody saw them. Forcing entity_ids to be written
  // by hand is a design flaw: the card ALREADY knows which doorbell it's bound to (`device_id`).
  //
  // How they're found, and why this way:
  //  1. The Home Assistant DEVICE whose `identifiers` contains
  //     ['ig_doorbell', config.device_id] - exactly how the integration registers it
  //     (entity.py / __init__.py). `hass.devices` also delivers it to NON-admin users
  //     (measured on the living-room tablet, Kiosko user: 347 devices with `identifiers`).
  //  2. If that gives nothing (an old frontend without `identifiers`), the anchor is the
  //     events entity returned by get_connection_info (`events_entity`), whose `device_id` is the same.
  //  3. From that device, the entity with `platform === 'ig_doorbell'` and the
  //     matching `translation_key` ('mode', 'rec', 'events'). NEVER by the entity_id's text:
  //     the user can rename it (and Ermita's already carries an area prefix, «calle_...»),
  //     and the same device also carries MQTT entities from the firmware with similar names
  //     (`select.*_modo_videoportero`, with OTHER options) that aren't the integration's.
  //
  // The YAML options still win if they're set: they're the manual override.
  // The result is cached by the identity of `hass.entities`/`hass.devices` (HA only replaces those
  // objects when the registry changes), so the cost on every state tick is one comparison.
  _autoEntity(translationKey) {
    const hass = this._hass;
    if (!hass || !hass.entities || !this.config) return null;
    const anchorEntity = this._connInfo && this._connInfo.events_entity;
    if (this._autoCache && this._autoCache.entities === hass.entities
        && this._autoCache.devices === hass.devices && this._autoCache.anchorEntity === anchorEntity
        && this._autoCache.doorbellId === this.config.device_id) {
      return this._autoCache.map[translationKey] || null;
    }
    const map = {};
    let haDevice = null;
    const devices = hass.devices || {};
    for (const id of Object.keys(devices)) {
      const ids = devices[id] && devices[id].identifiers;
      if (Array.isArray(ids) && ids.some((x) => x && x[0] === IG_DOMAIN && x[1] === this.config.device_id)) { haDevice = id; break; }
    }
    if (!haDevice && anchorEntity && hass.entities[anchorEntity]) haDevice = hass.entities[anchorEntity].device_id || null;
    if (haDevice) {
      for (const eid of Object.keys(hass.entities)) {
        const e = hass.entities[eid];
        if (e && e.device_id === haDevice && e.platform === IG_DOMAIN && e.translation_key && !map[e.translation_key]) {
          map[e.translation_key] = eid;
        }
      }
    }
    this._autoCache = { entities: hass.entities, devices: hass.devices, anchorEntity, doorbellId: this.config.device_id, map };
    if (!this._autoLogged && haDevice) {
      this._autoLogged = true;
      console.info('[ig-doorbell-card] doorbell entities found on their own:', JSON.stringify({ device: haDevice, mode: map.mode || null, rec: map.rec || null, events: map.events || null }));
    }
    return map[translationKey] || null;
  }

  // The effective entity for each feature: ALWAYS the one the integration publishes for this same
  // doorbell. (1.10.0, Iñaki 2026-09-26: the card has no configuration.) Until 1.9.8 the YAML's
  // `mode_entity`/`rec_entity`/`ring_entity`/`motion_entity` options were a manual
  // override; with two doorbells in the same card a hand-written entity could only belong to ONE, and
  // applying it to the other would show one doorbell's mode or REC over the other's video.
  // `motion` is the integration's presence binary_sensor (translation_key 'visitor').
  _entityFor(kind) {
    if (kind === 'mode') return this._autoEntity('mode');
    if (kind === 'rec') return this._autoEntity('rec');
    if (kind === 'ring') return (this._connInfo && this._connInfo.events_entity) || this._autoEntity('events');
    if (kind === 'motion') return this._autoEntity('visitor');
    return null;
  }

  _modeKeyFor(label) {
    const l = (label || '').toLowerCase();
    if (l.includes('ausente') || l.includes('away') || l.includes('fuera')) return 'away';
    if (l.includes('noche') || l.includes('night') || l.includes('do_not_disturb') || l.includes('molestar')) return 'night';
    if (l.includes('custom') || l.includes('personalizado')) return 'custom';
    if (l.includes('normal') || l.includes('home') || l.includes('casa')) return 'normal';
    return null;
  }

  // (v1.9.5) Dropdown chip, just like the apps' `_ModePill` (icon + label of the CURRENT
  // mode + arrow, instead of the usual row of 4 segmented chips) - "the modes should also be
  // a dropdown chip" (Iñaki, 2026-09-25). The dropdown itself (`.mode-menu`) is a
  // list of options, the same idea as the app's `PopupMenuButton`: icon + label per option,
  // highlighting the current one.
  _updateModeRow() {
    if (!this.modeRow) return;
    const entityId = this._entityFor('mode');
    const stateObj = entityId && this._hass ? this._hass.states[entityId] : null;
    // (1.10.0) With the doorbell out of reach the entity says 'unavailable': the chip used to render that
    // word as if it were a mode. With the doorbell selector that's seen as soon as you pick a powered-off
    // one, so it's treated the same as "no entity".
    if (!stateObj || stateObj.state === 'unavailable' || stateObj.state === 'unknown') {
      this.modeRow.style.display = 'none';
      this._lastModeSig = null;
      this._toggleModeMenu(false);
      return;
    }
    const options = (stateObj.attributes && Array.isArray(stateObj.attributes.options)) ? stateObj.attributes.options : [];
    if (options.length === 0) {
      this.modeRow.style.display = 'none';
      return;
    }
    // OPTIMISTIC (1.9.7, Iñaki 2026-09-25: «the mode button is pretty slow to show the
    // new mode ... sometimes it seems like it's not working»). The chip shows the chosen option ON TAP, marked
    // as pending (.pending), and reverts if the service call fails - see _pickMode(). Once the
    // entity already says the same as what was chosen, the pending state is confirmed and disappears.
    if (this._modePending && this._modePending.option === stateObj.state && this._modePending.done) this._modePending = null;
    const shown = this._modePending ? this._modePending.option : stateObj.state;
    const pending = !!(this._modePending && this._modePending.option !== stateObj.state);
    const sig = `${entityId}|${stateObj.state}|${shown}|${pending}|${options.join(',')}`;
    if (this._lastModeSig === sig) return; // no real changes, avoids repainting on every hass tick
    this._lastModeSig = sig;

    // The state is a KEY since integration 0.7.0 ('do_not_disturb'): Home Assistant's
    // translation is shown, in the viewer's language - same call as before, one per
    // option (including the current one, for the chip itself).
    const labelOf = (opt) => {
      let optLabel = opt;
      try { if (this._hass.formatEntityState) optLabel = this._hass.formatEntityState(stateObj, opt) || opt; } catch (err) { /* legacy frontend */ }
      return String(optLabel).replace(/</g, '&lt;');
    };
    const activeKey = this._modeKeyFor(shown);
    const activeMeta = activeKey ? MODE_META[activeKey] : null;
    const pillCls = ['mode-pill', activeKey ? `mode-${activeKey}` : '', pending ? 'pending' : ''].filter(Boolean).join(' ');

    this.modeRow.style.display = 'flex';
    this.modeRow.innerHTML = `
      <button type="button" class="${pillCls}" id="mode-pill" title="${labelOf(shown).replace(/"/g, '&quot;')}">
        <ha-icon icon="${activeMeta ? activeMeta.icon : 'mdi:tune'}"></ha-icon>
        <span class="mode-pill-label">${labelOf(shown)}</span>
        <ha-icon class="mode-pill-caret" icon="mdi:menu-down"></ha-icon>
      </button>
      <div class="mode-menu" id="mode-menu" style="display:none;">
        ${options.map((opt) => {
          const key = this._modeKeyFor(opt);
          const meta = key ? MODE_META[key] : null;
          const active = opt === shown;
          const cls = ['mode-opt', active ? 'sel' : '', key ? `mode-${key}` : ''].filter(Boolean).join(' ');
          const icon = meta ? meta.icon : 'mdi:circle-outline';
          const safeOpt = String(opt).replace(/"/g, '&quot;');
          return `<button type="button" class="${cls}" data-option="${safeOpt}"><ha-icon icon="${icon}"></ha-icon><span>${labelOf(opt)}</span></button>`;
        }).join('')}
      </div>
    `;

    this.modeRow.querySelector('#mode-pill').addEventListener('click', (ev) => {
      ev.stopPropagation(); // same reason as fullscreen/quality: there's a global listener that closes the menu
      this._toggleModeMenu();
    });
    this.modeRow.querySelectorAll('.mode-opt').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this._toggleModeMenu(false);
        this._pickMode(entityId, btn.getAttribute('data-option'), stateObj.state);
      });
    });
  }

  _pickMode(entityId, option, previous) {
    if (option === previous && !this._modePending) return;
    const token = {};
    this._modePending = { option, token, done: false };
    this._lastModeSig = null;
    this._updateModeRow();
    let call;
    try {
      call = this._hass.callService('select', 'select_option', { entity_id: entityId, option });
    } catch (err) {
      call = Promise.reject(err);
    }
    Promise.resolve(call).then(() => {
      // Accepted. With integration 0.7.4 the service call doesn't return until the doorbell has
      // confirmed it, and the entity already publishes it; with an older one the entity can take a while (the
      // 30 s polling): the chip stays on the chosen option, pending, until the entity matches.
      if (!this._modePending || this._modePending.token !== token) return;
      this._modePending.done = true;
      this._lastModeSig = null;
      this._updateModeRow();
      // Cap: if after 35 s (longer than the 30 s polling) the entity still doesn't say the chosen option, the
      // doorbell didn't apply it - it reverts and says so, never a chip pending forever.
      setTimeout(() => {
        if (!this._modePending || this._modePending.token !== token) return;
        this._modePending = null;
        this._lastModeSig = null;
        this._updateModeRow();
        this._flashStatusText(igEvText(this._hass, 'mode_failed'), 7000);
      }, 35000);
    }, (err) => {
      if (!this._modePending || this._modePending.token !== token) return;
      this._modePending = null;   // reverts: the entity still reports the real mode
      this._lastModeSig = null;
      this._updateModeRow();
      const why = err && err.message ? String(err.message) : '';
      this._flashStatusText(why ? igEvText(this._hass, 'mode_failed_why', { w: why }) : igEvText(this._hass, 'mode_failed'), 7000);
    });
  }

  _flashStatusText(text, ms) {
    if (!this.statusLine) return;
    this.statusLine.textContent = text;
    this.statusLine.classList.remove('open');
    this.statusLine.classList.add('warn');
    clearTimeout(this._flashTextTimer);
    this._flashTextTimer = setTimeout(() => { if (!this._doorCountdownTimer && !this._retryCountdownTimer) this._resetStatusLine(); }, ms);
  }

  _toggleModeMenu(force) {
    const menu = this.modeRow ? this.modeRow.querySelector('#mode-menu') : null;
    if (!menu) return;
    const open = (typeof force === 'boolean') ? force : menu.style.display === 'none';
    menu.style.display = open ? 'flex' : 'none';
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════
  //  DOORBELL SELECTOR (1.10.0, Iñaki 2026-09-26: «one card, choosing between doorbells in
  //  real time»). The LIST and the SWITCHING belong to the card (IgDoorbellCard, below); this
  //  instance only paints the capsule and reports what was chosen. Switching doorbells does NOT happen
  //  in here: the card DESTROYS this instance (_destroy) and creates another one for the new doorbell. See
  //  the reasoning in IgDoorbellCard._switchTo().
  // ══════════════════════════════════════════════════════════════════════════════════════════
  _setDoorbells(list, onPick) {
    this._doorbells = Array.isArray(list) ? list : [];
    this._onPickDoorbell = onPick || null;
    this._paintPicker();
  }

  _paintPicker() {
    if (!this._dbPill || !this.config) return;
    const list = this._doorbells || [];
    const me = list.find((d) => d.id === this.config.device_id);
    // The name is the doorbell's (dname, which integration 0.7.7 sets as the device's
    // name). NEVER the hex id: if there's no name, a translated generic text.
    const name = (me && me.name) || getLocalText(this._hass, 'db_unnamed');
    const many = list.length > 1;
    const sig = `${name}|${many}|${list.map((d) => `${d.id}:${d.name}:${d.available}`).join(',')}`;
    if (this._lastPickerSig === sig) return;
    this._lastPickerSig = sig;
    this._dbName.textContent = name;
    // The chevron and the tap go TOGETHER (the apps' DoorbellCapsule rule): with a single doorbell
    // the capsule is the title, not a dropdown that drops down nothing.
    this._dbChev.style.display = many ? '' : 'none';
    this._dbPill.classList.toggle('pickable', many);
    this._dbPill.setAttribute('aria-haspopup', many ? 'menu' : 'false');
    this._dbPill.setAttribute('title', many ? getLocalText(this._hass, 'db_switch') : name);
    if (!many) this._toggleDbMenu(false);
    else if (this._dbMenu && this._dbMenu.style.display !== 'none') this._renderDbMenu();
  }

  _toggleDbMenu(force) {
    if (!this._dbMenu) return;
    const many = (this._doorbells || []).length > 1;
    const open = many && ((typeof force === 'boolean') ? force : this._dbMenu.style.display === 'none');
    if (open) { this._toggleModeMenu(false); this._renderDbMenu(); }
    this._dbMenu.style.display = open ? 'flex' : 'none';
  }

  _renderDbMenu() {
    const list = this._doorbells || [];
    const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    const liveState = (this._dbDot && this._dbDot.dataset.state) || 'connecting';
    this._dbMenu.innerHTML = `<div class="db-menu-title">${esc(getLocalText(this._hass, 'db_switch'))}</div>` + list.map((d) => {
      const cur = d.id === this.config.device_id;
      // The dot on the current row is the session's own (the same one as the capsule). The dot for
      // the others is REAL data from Home Assistant (their entities available = the integration's
      // last poll answered); if it's not known, nothing is painted: a made-up color would announce a
      // healthy doorbell as down (the apps' DoorbellCapsule rule).
      const dot = cur ? liveState : (d.available === true ? 'avail' : d.available === false ? 'down' : '');
      const name = d.name || getLocalText(this._hass, 'db_unnamed');
      return `<button type="button" class="db-opt${cur ? ' sel' : ''}" data-id="${esc(d.id)}" role="menuitem">
        <ha-icon class="db-check" icon="${cur ? 'mdi:check' : ''}"></ha-icon>
        <span class="db-dot" data-state="${dot}"${dot ? '' : ' style="visibility:hidden"'}></span>
        <span class="db-opt-name">${esc(name)}</span>
      </button>`;
    }).join('');
    this._dbMenu.querySelectorAll('.db-opt').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this._toggleDbMenu(false);
        const id = btn.getAttribute('data-id');
        if (id && id !== this.config.device_id && this._onPickDoorbell) this._onPickDoorbell(id);
      });
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════
  //  DESTROYING THIS INSTANCE (1.10.0) -- «when you switch doorbells, EVERYTHING changes».
  //
  //  It's NOT disconnectedCallback(): leaving the DOM means PAUSING (live_pause, `bye` at 15 s, and
  //  resuming if it comes back -- the 2026-09-25 rule). Switching doorbells means HANGING UP NOW: `bye`, closing the
  //  peer, releasing the mic and the turn, stopping every timer, and forgetting this doorbell's
  //  stored pause, so coming back to it is a new session, not a resumption of this one.
  //
  //  What this must NOT do, and it's on purpose: clear the instance's state field by
  //  field. The card doesn't reuse this element -- it creates another one --, so no data from this
  //  doorbell (alert list, quick replies, /api/whoami role, turn, quality, rotation...) can
  //  show up in the other one: there's no "things to clean up" list that could fall short, which is
  //  exactly how the apps failed (the dot). The only thing that has to be cut off is whatever leaks
  //  OUTSIDE the instance: network, mic, timers, document/window listeners and the module's
  //  state (PAUSED_BY_DOORBELL). `_destroyed` also shuts the door on any in-flight callback
  //  that might try to start a session or reopen the mic afterwards.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  _destroy(reason) {
    if (this._destroyed) return;
    console.info(`[ig-doorbell-card] instance of ${this.config && this.config.device_id} destroyed (${reason})`);
    this._cancelPause();
    if (this._livePauseAck) { clearTimeout(this._livePauseAck.timer); this._livePauseAck = null; }
    this._clearReconnectTimer();
    this._reconnecting = false;
    this._clearIdleWakeLockTimer();
    // Real teardown, with `bye` if there's a session. Goes BEFORE marking `_destroyed` because the `bye` goes out via
    // sendNativeSignal(), which stops sending anything once that mark is set.
    this._teardownConnectionObjects();
    this._destroyed = true;
    if (this.config) delete PAUSED_BY_DOORBELL[this.config.device_id];
    if (this._flashTextTimer) { clearTimeout(this._flashTextTimer); this._flashTextTimer = null; }
    if (this.videoEl) {
      try { this.videoEl.pause(); } catch (err) { /* best effort */ }
      this.videoEl.srcObject = null;
    }
    this._toggleDbMenu(false);
    this._releaseListeners();
  }

  _updateMotionPill() {
    if (!this.motionPill) return;
    const entityId = this._entityFor('motion');
    const stateObj = entityId && this._hass ? this._hass.states[entityId] : null;
    // Explicitly agreed rule (COORDINATION.md Q22-bis): never visible while the mic is active.
    const shouldShow = !!stateObj && stateObj.state === 'on' && !this.talkActive;
    this.motionPill.style.display = shouldShow ? 'flex' : 'none';
  }

  // ==============================================================================
  // REC (recordings v2, Iñaki 2026-09-25) - "the card SHOWS, the integration EXPOSES" (decision from
  // 2026-08-31, see hass_todo_en_la_integracion): unlike the apps (which talk rec_start/
  // rec_stop directly with the doorbell over the signaling session, WebRTCSession.swift /
  // live_session_wiring.dart), this card NEVER opens its own channel to record - it calls the
  // service of the `rec_entity` entity the user configures, which must point to the switch.* that
  // the ig_doorbell integration publishes (in progress, v0.7.2 as of this change: there
  // is already `rec_session.py` in that integration, which keeps the session open for as long as the
  // recording lasts, but the `switch` entity that exposes it doesn't exist yet - see `switch.py`,
  // missing). While that entity doesn't exist, `rec_entity` is left UNCONFIGURED (hidden), never
  // pointing to a made-up entity_id - a button that calls a service that doesn't exist would fail
  // silently except for the error in HA's log (§1.0 point 5: a failure is reported, never faked).
  //
  // Visible only to a Home Assistant administrator (same criterion as the apps' RecordingButtonRule:
  // "only an administrator sees and uses it", memory grabacion_manual_boton_rec) and only
  // with `rec_entity` configured and that entity present in `hass.states` - just like
  // unlock_entity/mode_entity/motion_entity, completely hidden if it doesn't apply, never disabled
  // while lying that it exists.
  //
  // The "is recording" state is NEVER guessed locally (not from the last tap, not from whether the
  // mic is open): it's rendered exactly as `rec_entity.state` says ('on'/'off'), which is what
  // the integration will have synced from the doorbell's real `rec_state` - the SAME rule the apps
  // already apply (RecordingButtonRule.blinks), here expressed against an HA entity instead
  // of against the native message.
  // (1.9.3) The above about `rec_entity` is history: the switch has existed since integration
  // 0.7.2 and the card finds it on its own by device + translation_key 'rec' (_autoEntity);
  // `rec_entity` remains as a manual override.
  //
  // (1.9.4, Iñaki 2026-09-25) It's NO LONGER `hass.user.is_admin`. That was the account of whoever's viewing THIS
  // Home Assistant panel - on the living-room tablet, "Kiosko", which is not an HA administrator, and
  // that's why REC never showed up there, even though the integration is paired as the doorbell's
  // administrator. What governs it is the role the DOORBELL gave the integration's credential when it
  // was paired (API_CONTRACT.md §3.3-ter, `session_info.role`/`/api/whoami`), which arrives in
  // `get_connection_info` (`this._connInfo.role`, the integration's websocket_api.py) - the same
  // channel `live_timeout_entity`/`events_entity` already arrive on, never the credential. The
  // doorbell is still the one that actually enforces this (rec_start rejects with
  // `admin_required` anyone who isn't an admin, no matter what happens here): this is only what gets shown.
  // (v1.9.5) The small capsule with a red dot + "REC" reproduces the apps' RecButton.dart
  // (Android/iOS) in detail: "REC" is NEVER translated -- it's the universal label for a recorder,
  // same as in the apps -- so here only the 'recording' class changes (color/blink of the
  // dot and the text, see CSS .rec-pill) and the title/aria-label, which DO get translated for whoever
  // uses a screen reader. The rest of the logic (gating by _connInfo.role, state read from the
  // ENTITY and never from the last tap) doesn't change from 1.9.4.
  _updateRecButton() {
    if (!this.recAction || !this.recButton) return;
    const entityId = this._entityFor('rec');
    const isAdmin = !!(this._connInfo && this._connInfo.role === 'admin');
    const stateObj = entityId && this._hass ? this._hass.states[entityId] : null;
    const visible = isAdmin && !!stateObj;
    this.recAction.style.display = visible ? '' : 'none';
    if (!visible) return;
    const recording = stateObj.state === 'on';
    this.recButton.classList.toggle('recording', recording);
    const tip = getLocalText(this._hass, recording ? 'rec_stop_tip' : 'rec_start_tip');
    this.recButton.setAttribute('title', tip);
    this.recButton.setAttribute('aria-label', tip);
    this.recButton.setAttribute('aria-pressed', recording ? 'true' : 'false');
  }

  // Recordings (v1.9.5, Iñaki 2026-09-25): same visibility criterion as REC -- only
  // administrators, based on the ROLE THE DOORBELL gave this integration when it was paired
  // (`_connInfo.role`, never `hass.user.is_admin`, same reason as _updateRecButton()) -- because
  // recordings are "admin-only in the apps, with the same rule as REC". Unlike
  // REC it doesn't depend on any entity: it's just a link, so the role alone is enough
  // to decide whether to show it.
  _updateRecordingsButton() {
    if (!this.recordingsButton) return;
    const isAdmin = !!(this._connInfo && this._connInfo.role === 'admin');
    const displayBefore = this.recordingsButton.style.display;
    this.recordingsButton.style.display = isAdmin ? '' : 'none';
    if (displayBefore !== this.recordingsButton.style.display) this._scheduleFit();   // changes the height to distribute
    this._updateBottomRowVisibility();
  }

  // Quick reply (v1.9.8): unlike Recordings, ANY user sees it -- the doorbell itself
  // doesn't require admin for `?quick=1` nor for the `play_sequence` message (§1.18.8/§1.18.1),
  // so here it's enough for a connection to be established (_connInfo != null). It lives in a
  // method separate from _updateRecordingsButton() on purpose: the two buttons share a row but do NOT
  // share a visibility rule, and merging them into a single `if` is exactly how one of the two
  // rules gets lost the day someone only looks at one condition (see CLAUDE.md, the "defense
  // spread across places" landmines).
  _updateQuickReplyButton() {
    if (!this.qrButton) return;
    const show = !!this._connInfo;
    const displayBefore = this.qrButton.style.display;
    this.qrButton.style.display = show ? '' : 'none';
    if (displayBefore !== this.qrButton.style.display) this._scheduleFit();
    this._updateBottomRowVisibility();
  }

  // The whole row is only visible if AT LEAST one of the two buttons is visible -- if Recordings is
  // hidden (non-admin user) the other button takes up the whole row on its own, for free, by being flex:1 (see CSS
  // .quick-btn.half): no special case is needed for that width.
  _updateBottomRowVisibility() {
    if (!this.recordingsAction) return;
    const anyVisible = (this.recordingsButton && this.recordingsButton.style.display !== 'none')
      || (this.qrButton && this.qrButton.style.display !== 'none');
    this.recordingsAction.style.display = anyVisible ? '' : 'none';
  }

  // Opens Home Assistant's NATIVE media browser against the media_source the integration
  // already publishes (media_source.py/DoorbellMediaSource: identifier `<device_id>` = THIS
  // doorbell's folder, `media-source://ig_doorbell/<device_id>`) -- never a player of our
  // own (Iñaki's decision, 2026-09-25: "recordings as such are phase 2; this is just the
  // access"). The panel URL is the one `ha-panel-media-browser.ts` in the
  // frontend really builds (createMediaPanelUrl): `/media-browser/<entity-or-"browser">/<encoded type,id>`,
  // with `browser` as the marker for "no associated player" (BROWSER_PLAYER in
  // data/media-player.ts) to navigate the media_source without needing a media_player entity. It
  // navigates with the same pattern the WHOLE frontend uses (`history.pushState` +
  // `location-changed`), not an `<a href>`, so as not to reload the entire page and lose this
  // same card's ongoing WebRTC session.
  _openRecordings() {
    const deviceId = this.config && this.config.device_id;
    if (!deviceId) return;
    const mediaContentId = `media-source://${IG_DOMAIN}/${deviceId}`;
    const path = `/media-browser/browser/${encodeURIComponent(`video,${mediaContentId}`)}`;
    history.pushState(null, '', path);
    window.dispatchEvent(new CustomEvent('location-changed', { detail: { replace: false } }));
  }

  // ==============================================================================
  // Quick reply (v1.9.8, Iñaki 2026-09-25): "Recordings and Quick Replies" as two
  // buttons on the same row (see the #bottom-row markup and _updateQuickReplyButton() further
  // up). The list ALWAYS comes from the integration (ig_doorbell/get_quick_replies,
  // websocket_api.py), which in turn reads it from the doorbell via `GET /api/sequences?quick=1`
  // (API_CONTRACT.md §1.18.8) -- NEVER from `/api/list_audios`, the retired 10-slot mechanism
  // (the landmine that made Android say "there are none" while having them: it read that old route).
  // Firing one calls the `play_sequence` service the integration has already exposed since Phase 0
  // ("the card shows, the integration exposes") -- that same signaling message is what
  // resolves a ring in progress (§1.18.1: it cuts the street announcement instead of chaining the
  // no-answer sequence), so this card needs no separate path for that case:
  // it's the SAME button, tapped at the SAME moment, and the firmware already tells them apart.
  // ==============================================================================
  _openQuickReplies() {
    if (!this._qrPanel) return;
    this._qrOpen = true;
    this._qrPanel.style.display = 'flex';
    this._qrError = null;
    this._qrNotice = null;
    this._qrPlaying = null;
    // Renders with whatever it already had (if this is the second time it's opened in this instance) and
    // refreshes underneath -- same criterion as the bell, and the same the contract requires for
    // the apps' quick replies (§1.18.8: "the cached data is rendered immediately").
    this._renderQuickReplies();
    this._loadQuickReplies();
  }

  _closeQuickReplies() {
    this._qrOpen = false;
    if (this._qrPanel) this._qrPanel.style.display = 'none';
  }

  async _loadQuickReplies() {
    const deviceId = this.config && this.config.device_id;
    if (!deviceId || !this._hass || !this._hass.connection) return;
    const gen = (this._qrGen = (this._qrGen || 0) + 1);
    try {
      const res = await this._hass.connection.sendMessagePromise({
        type: `${IG_DOMAIN}/get_quick_replies`,
        device_id: deviceId,
      });
      if (gen !== this._qrGen) return;   // the panel was closed and reopened in the meantime
      // A network failure does NOT clear whatever was already rendered (§1.18.8) -- only a
      // good response overwrites it. `res.quick_replies` is always a list (empty if the doorbell has
      // none configured), never `undefined`.
      this._qrItems = Array.isArray(res && res.quick_replies) ? res.quick_replies : [];
      this._qrError = null;
    } catch (err) {
      if (gen !== this._qrGen) return;
      console.warn('[ig-doorbell-card] get_quick_replies', err);
      this._qrError = true;
      if (this._qrItems === undefined) this._qrItems = null;   // first attempt: nothing to show yet
    }
    if (this._qrOpen) this._renderQuickReplies();
  }

  _renderQuickReplies() {
    const p = this._qrPanel;
    if (!p) return;
    const T = (k) => getLocalText(this._hass, k);
    const E = (k) => igEvText(this._hass, k);
    const esc = (v) => String(v).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
    let body;
    if (this._qrItems == null && this._qrError) {
      body = `<div class="ev-empty"><ha-icon icon="mdi:alert-circle-outline"></ha-icon><div>${T('qr_load_error')}</div></div>`;
    } else if (this._qrItems == null) {
      body = `<div class="ev-empty"><div>${E('loading')}</div></div>`;
    } else if (this._qrItems.length === 0) {
      body = `<div class="ev-empty"><ha-icon icon="mdi:message-off-outline"></ha-icon><div class="ev-empty-t">${T('qr_empty')}</div></div>`;
    } else {
      const qrLocked = this._qrPlaying != null;
      body = this._qrItems.map((it) => {
        const inFlight = this._qrPlaying === it.id;
        const icon = inFlight ? 'mdi:loading' : 'mdi:message-reply-text-outline';
        return `<button type="button" class="ev-row qr-row" data-id="${it.id}"${qrLocked ? ' disabled' : ''}>` +
          `<span class="ev-ic c-blue"><ha-icon icon="${icon}"${inFlight ? ' class="qr-spin"' : ''}></ha-icon></span>` +
          `<div class="ev-txt"><div class="ev-t">${esc(it.label)}</div></div></button>`;
      }).join('');
    }
    p.innerHTML = `
      <div class="ev-head">
        <button type="button" class="ev-back" id="qr-back" title="${E('back')}"><ha-icon icon="mdi:chevron-left"></ha-icon></button>
        <div class="ev-title">${T('quick_reply_title')}</div>
      </div>
      ${this._qrNotice ? `<div class="qr-notice">${esc(this._qrNotice)}</div>` : ''}
      <div class="ev-list">${body}</div>
    `;
    p.querySelector('#qr-back').addEventListener('click', (ev) => { ev.stopPropagation(); this._closeQuickReplies(); });
    p.querySelectorAll('.qr-row').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this._playQuickReply(parseInt(btn.getAttribute('data-id'), 10));
      });
    });
  }

  // Fires the sequence with the SAME service that already existed (ig_doorbell.play_sequence,
  // the integration's services.py) -- this card has no HTTP route of its own, same as REC/Recordings
  // ("the card shows, the integration exposes"). If there's a ring sounding right now, the firmware
  // (seq_engine_quick_reply(), §1.18.1) cuts the announcement and does NOT chain the no-answer one with
  // this same message: nothing special to do here for that case.
  //
  // A failure does NOT close the panel (same criterion as iOS's QuickRepliesSheet): whoever's waiting
  // at the door needs to be able to retry without reopening the list, and closing it would leave the notice
  // floating over another screen with nothing to tap.
  _playQuickReply(seqId) {
    if (!Number.isFinite(seqId) || this._qrPlaying != null) return;
    const deviceId = this.config && this.config.device_id;
    if (!deviceId || !this._hass) return;
    this._qrPlaying = seqId;
    this._qrNotice = null;
    this._renderQuickReplies();
    Promise.resolve(
      this._hass.callService(IG_DOMAIN, 'play_sequence', { device_id: deviceId, seq_id: seqId })
    ).then(() => {
      this._qrPlaying = null;
      // A success closes outside this screen, same as in the apps: staying here doesn't add
      // anything once the doorbell is already talking out on the street.
      this._closeQuickReplies();
    }).catch((err) => {
      this._qrPlaying = null;
      const detailText = err && err.message ? String(err.message) : '';
      this._qrNotice = detailText || getLocalText(this._hass, 'qr_no_answer');
      console.error('[ig-doorbell-card] play_sequence', err);
      if (this._qrOpen) this._renderQuickReplies();
    });
  }

  // A toggle on what the ENTITY says, never on the last tap (same principle as
  // RecordingButtonRule.request in the apps): if another admin already stopped it or the doorbell closed it
  // by itself (the 10-minute cap, a call taking over the slot), the next tap requests the opposite of
  // what's there NOW, not the opposite of what we last requested.
  toggleRec() {
    const entityId = this._entityFor('rec');
    if (!this._hass || !entityId) return;
    const domain = entityId.split('.')[0];
    const stateObj = this._hass.states[entityId];
    const recording = !!stateObj && stateObj.state === 'on';
    const service = recording ? 'turn_off' : 'turn_on';
    Promise.resolve(this._hass.callService(domain, service, { entity_id: entityId }))
      .catch((err) => {
        console.error(`[ig-doorbell-card] Home Assistant rejected ${domain}.${service} on ${entityId}`, err);
        this._flashStatusLine('rec_no_answer', 6000);
      });
  }

  // ==============================================================================
  // Visual state of the "live-tag" (the LIVE/Connecting/Error pill overlaid on the video, top-
  // left corner) and of the labels under the action buttons - centralized so that
  // every place that used to do `this.badge.textContent = ...` by hand has a single point that
  // also updates the dot's color/pulse and can't drift out of sync.
  // ==============================================================================
  // The status chip is governed by REALITY, not just signaling (2026-07-29, reported on
  // real hardware: "I saw an error on the status chip at the same time there was video").
  //
  // How it happened: the aggressive reconnection shortcut also fires on connectionState
  // 'disconnected', which can be transient. That paints the chip as error; if ICE then
  // recovers on its own right after, NOTHING ever put the chip back in its place -- setupRemoteStream() only repaints
  // when a NEW stream arrives, and there the stream was the same one as always. The chip stayed in
  // error indefinitely with the video running right in front of it.
  //
  // Why it matters more than it looks: an indicator that lies in the pessimistic direction
  // trains the user to ignore it, and then it's useless the day the error is real.
  // If frames are arriving, there's no error: it says what it sees.
  _confirmLiveFromMedia() {
    if (this._liveStateKey !== 'error_cam' && this._liveStateKey !== 'connecting') return;
    this._setLiveState(this.talkActive ? 'open' : 'live');
  }

  _setLiveState(stateKey) {
    if (this.badge) this.badge.textContent = getLocalText(this._hass, stateKey);
    this._liveStateKey = stateKey;
    const dataState = stateKey === 'live' ? 'live'
      : stateKey === 'error_cam' ? 'error'
      : stateKey === 'open' ? 'open'
      : stateKey === 'no_lock' ? 'warn'
      : stateKey === 'paused' ? 'warn'
      : 'connecting';
    if (this.liveTag) this.liveTag.dataset.state = dataState;
    // Also in .feed-wrap: the test benches read it (the signal bars that used it via
    // CSS were removed in 1.10.0).
    if (this.feedWrap) this.feedWrap.dataset.state = dataState;
    // ⚠️ THE DOORBELL SELECTOR'S DOT COMES FROM HERE, AND NOWHERE ELSE (1.10.0).
    // The bug BOTH apps had: the header changed name when switching doorbells and the
    // dot stayed green, announcing a doorbell with no session (on Android it was a FIXED green). Here
    // the dot is the SAME state as the live-tag -- the session of THIS instance, which belongs to ONE
    // doorbell -- and a new instance is born in 'connecting'. Green only with real video.
    if (this._dbDot) this._dbDot.dataset.state = dataState;
  }

  // NOTE (2026-07-26): the old _setMicLabel(active) went away when the talk turn was
  // introduced - the mic button no longer has two states (on/off) but five (off, requesting
  // turn, talking, listen-only, busy with someone else), and spreading them across several
  // functions was a recipe for them to drift out of sync. All of that now lives in a single
  // _paintMicState(), further below.

  _setDoorLabel(active) {
    if (!this.unlockLabel) return;
    this.unlockLabel.textContent = getLocalText(this._hass, active ? 'lbl_door_open' : 'lbl_door_idle');
    this.unlockLabel.classList.toggle('on-green', !!active);
  }

  // Status line under the video (different from the live-tag: that one is about the CONNECTION
  // STATE, this one is about the DOOR STATE). Real countdown, updated every second.
  _startDoorCountdown(seconds) {
    if (!this.statusLine) return;
    if (this._doorCountdownTimer) { clearInterval(this._doorCountdownTimer); this._doorCountdownTimer = null; }
    let remaining = Math.max(1, parseInt(seconds, 10) || 1);
    const paint = () => {
      this.statusLine.textContent = `${getLocalText(this._hass, 'door_open_prefix')} ${remaining}s`;
      this.statusLine.classList.remove('warn');
      this.statusLine.classList.add('open');
    };
    paint();
    this._doorCountdownTimer = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        clearInterval(this._doorCountdownTimer);
        this._doorCountdownTimer = null;
        this._resetStatusLine();
        return;
      }
      paint();
    }, 1000);
  }

  // Countdown to the next connection retry (§1.0). Same shape as the door's, and for
  // the same reason: a number counting down reads at a glance as "this is still alive", while
  // fixed text -or worse, just a spinning circle- doesn't distinguish "waiting" from "stuck".
  //
  // Yields to the sticky pairing-rejected notice: there the problem isn't the wait but
  // that there's something to do about it, and covering that message with a counter would trade useful
  // information for noise.
  _startRetryCountdown(ms) {
    if (!this.statusLine || this._stickyStatusKey) return;
    if (this._doorCountdownTimer) { clearInterval(this._doorCountdownTimer); this._doorCountdownTimer = null; }
    if (this._retryCountdownTimer) { clearInterval(this._retryCountdownTimer); this._retryCountdownTimer = null; }
    let secondsLeft = Math.max(1, Math.round(ms / 1000));
    const paintCountdown = () => {
      this.statusLine.textContent = `${getLocalText(this._hass, 'retry_prefix')} ${secondsLeft}s`;
      this.statusLine.classList.remove('open');
      this.statusLine.classList.add('warn');
    };
    paintCountdown();
    this._retryCountdownTimer = setInterval(() => {
      secondsLeft -= 1;
      if (secondsLeft <= 0) {
        clearInterval(this._retryCountdownTimer);
        this._retryCountdownTimer = null;
        // It doesn't revert to "Sistema operativo": it's genuinely reconnecting at this very instant.
        this.statusLine.textContent = getLocalText(this._hass, 'connecting');
        return;
      }
      paintCountdown();
    }, 1000);
  }

  _stopRetryCountdown() {
    if (this._retryCountdownTimer) { clearInterval(this._retryCountdownTimer); this._retryCountdownTimer = null; }
  }

  _flashStatusLine(stateKey, ms) {
    if (!this.statusLine) return;
    this._stopRetryCountdown();
    if (this._doorCountdownTimer) { clearInterval(this._doorCountdownTimer); this._doorCountdownTimer = null; }
    this.statusLine.textContent = getLocalText(this._hass, stateKey);
    this.statusLine.classList.remove('open');
    this.statusLine.classList.add('warn');
    setTimeout(() => { if (!this._doorCountdownTimer && !this._retryCountdownTimer) this._resetStatusLine(); }, ms);
  }

  _resetStatusLine() {
    if (!this.statusLine) return;
    // A STICKY notice (today only the pairing-rejected one) describes a situation that's still
    // there: no timer or Home Assistant tick can clear it. Only the actual
    // cause disappearing removes it - see _clearPairingRejected().
    if (this._stickyStatusKey) {
      this.statusLine.textContent = getLocalText(this._hass, this._stickyStatusKey);
      this.statusLine.classList.remove('open');
      this.statusLine.classList.add('warn');
      return;
    }
    if (this._pauseState) {
      this.statusLine.classList.remove('open');
      this.statusLine.classList.add('warn');
      this.statusLine.textContent = getLocalText(this._hass, 'paused_tap');
      return;
    }
    this.statusLine.classList.remove('open', 'warn');
    // Empty at rest (1.9.7, Iñaki: «"System idle" doesn't add anything; same as removing
    // "system running" from Android»). The line only speaks when there's something to say.
    this.statusLine.textContent = '';
  }

  // ==============================================================================
  // "THE DOORBELL DOESN'T KNOW ME": pairing credential rejected
  //
  // It really happens and it's not rare: a factory reset on the doorbell wipes the NVS, and with it the
  // hashes of the pair_app credentials that the local path validates (§1.5). The card authenticates with
  // that credential and no other - it deliberately doesn't store an admin username/password,
  // which is exactly what pairing exists to avoid (§4).
  //
  // What must NOT happen, and what used to happen: silently keep retrying with the chip stuck on
  // "Connecting..." indefinitely. Retrying is fine (the doorbell may come back), but the
  // user has to be able to read that what's missing is re-pairing, not waiting.
  //
  // The three reliable signals, all with a code, none guessed:
  //   - relay: WebSocket closed with code 4401 (§3.2)
  //   - cloud: get_turn_credentials replies 'unauthorized' (§3.1-bis)
  //   - local: Home Assistant's signaling proxy returns 401 (it passes it through as-is from the
  //     doorbell, precisely so a client can say "re-pair")
  // ==============================================================================
  _reportPairingRejected(source) {
    if (this._pairingRejected) return; // already reported, don't repaint on every retry
    this._pairingRejected = true;
    this._stickyStatusKey = 'cred_revoked';
    console.error(`[ig-doorbell-card] this card's pairing has been rejected (${source}) - the doorbell needs to be re-paired in Settings > Devices & services > Islautopia Garage Doorbell`);
    this._resetStatusLine();
  }

  _clearPairingRejected() {
    if (!this._pairingRejected) return;
    this._pairingRejected = false;
    this._stickyStatusKey = null;
    this._resetStatusLine();
  }

  // ==============================================================================
  // MULTI-CLIENT: TALK TURN (API_CONTRACT.md §1.4-ter #1)
  //
  // The doorbell has ONE single voice channel: until the 2026-07-26 contract, two clients with the
  // mic open put their two streams CONCATENATED into the same speaker buffer
  // (unintelligible, and at twice the rate the speaker drains it). Now arbitration is per
  // slot: this card requests the turn BEFORE unmuting and only opens the mic with a real
  // talk_granted - never "open the mic and see if it plays".
  //
  // Degradation with firmware PREDATING the contract (explicit requirement): that firmware
  // simply DOESN'T REPLY to talk_request - no error, just silence. A client that waited
  // indefinitely would leave the mic button useless forever against the already-installed
  // fleet. Hence: a 3s wait (same deadline as the Android app, so the product
  // behaves the same across all three clients) and, if nothing arrives, the mic opens anyway,
  // reporting it ONCE, and _talkUnsupported gets set so subsequent taps in THAT
  // session are instant. The new firmware itself backs this choice: it implements "implicit
  // turn-taking" precisely so clients that never request a turn keep
  // working (§1.4-ter, "Compatibility").
  // ==============================================================================
  _requestTalkTurn() {
    if (this._talkUnsupported) {
      // We already know (in THIS session) that this doorbell doesn't arbitrate the turn - mic goes direct, without
      // making the user wait 3s again.
      this._startTalk();
      return;
    }
    this._talkPending = true;
    this._paintMicState();
    this.sendNativeSignal({ type: 'talk_request' });
    if (this._talkTimer) clearTimeout(this._talkTimer);
    this._talkTimer = setTimeout(() => {
      this._talkTimer = null;
      if (!this._talkPending) return;
      this._talkPending = false;
      // Don't blame it on absence if there's evidence to the contrary (2026-07-29, after the false positive
      // on real hardware). `session_info` belongs to the SAME contract as the talk turn: a
      // doorbell that sends it knows how to arbitrate turns, period. If we've ever received it,
      // getting no reply to a talk_request is a lost message -- status notices get
      // dropped when the outgoing queue is full, that's documented -- not old firmware.
      //
      // The difference matters: blaming the user's firmware when their firmware is fine sends
      // them looking for an update that doesn't exist, and it also leaves `_talkUnsupported` set
      // for the rest of the session, meaning the turn is never properly requested again.
      // With no evidence (a session_info never arrived) the assumption of older firmware is
      // indeed reasonable, and it stays.
      if (this._clients === null) {
        this._talkUnsupported = true;
        console.warn('[ig-doorbell-card] the device did not answer talk_request within 3s and has never sent session_info - assuming firmware predating the talk-turn contract, opening the mic with no arbitration');
        this._flashStatusLine('talk_legacy', 5000);
      } else {
        console.warn('[ig-doorbell-card] no response to talk_request within 3s, but this doorbell DOES speak the talk-turn contract (it has sent session_info) - treated as a lost message, not older firmware: the mic opens and the turn will keep being requested normally');
      }
      this._startTalk();
    }, 3000);
  }

  // Is this talk_granted/talk_denied REALLY for us?
  //
  // CONTRACT RESOLUTION COMMON TO ALL THREE CLIENTS (card, Android, iOS - 2026-07-26, decided
  // by the lead after reviewing all three codebases). Three rules, and all three matter:
  //
  //   1. NEVER learn your own identity from a message you're currently validating. It's circular: if
  //      `talk_granted` could set `this._slot`, then `msg.slot === this._slot` would be
  //      true ALWAYS and the check would check nothing. The Android app had
  //      exactly that bug (`_mySlot ??= msg.slot` inside the handler itself). That's why the
  //      own slot is learned ONLY in `offer`/`session_info` - see handleNativeSignal(), and do NOT
  //      move it out of there for convenience.
  //   2. BOTH guards are required, not just one: an own request in flight (`_talkPending`) AND a matching
  //      slot. Each one plugs a different hole (see the case below).
  //   3. Own slot unknown => REJECT. This function used to return `true` in that case until this
  //      resolution; it was the weak link.
  //
  // Why rejecting is correct and doesn't break anything, with the real firmware in front of us: `sig_out_push()`
  // adds `slot` to ALL of the device's messages over BOTH transports, including the offer
  // itself. By the time the user can tap the mic button (only enabled once video arrives,
  // long after the offer) the own slot is ALWAYS already known => zero false negatives.
  //
  // And the genuinely dangerous case, which ONLY this rule covers: two users tapping the mic at the
  // same time, both with a request in flight, and one's `talk_granted` reaching the other via the
  // relay's fan-out. There `_talkPending` is true in BOTH, so the own-request guard
  // stops nothing - only comparing the slot stops it. Accepting "because I don't know who I am" would
  // mean opening the wrong user's microphone right at the moment of highest concurrency.
  //
  // Deliberate asymmetry with the message WITHOUT `slot` (intermediate firmware, between the old contract
  // and this one): that one IS accepted relying only on `_talkPending`. It's not the same case: there the data
  // doesn't exist, and rejecting would leave the mic useless against that firmware - exactly the degradation
  // this project doesn't accept. In the case above the data DOES exist and it's us who
  // don't know what to compare it against, which is a symptom of a corrupted state, not of an old doorbell.
  // Honest consequence of the rejection, documented so nobody discovers it by surprise: if a
  // talk_granted gets rejected, the request stays "in flight" and at 3s the old-firmware
  // timer fires, opening the mic with no arbitration. In practice it's unreachable (the own
  // slot is always known before the mic button gets enabled, see above) and even so
  // it's no worse than the pre-contract behavior; adding more machinery for a path
  // that can't happen would cost more than it fixes.
  _talkMsgIsForUs(msg) {
    if (typeof msg.slot !== 'number') return true; // intermediate firmware: no slot to compare
    if (this._slot === null) return false;         // we don't know who we are: not something we can assume
    return msg.slot === this._slot;
  }

  _handleTalkGranted(msg) {
    // Deliberate exception to the slot filter. Fixes a REAL bug seen on an iPhone against
    // real hardware (2026-07-29): opening the mic showed "this doorbell doesn't confirm the voice
    // turn (older firmware)" on a perfectly up-to-date doorbell.
    //
    // Cause: over the REMOTE path the offer doesn't carry `slot` -- it doesn't need to, the relay routes
    // by device_id -- so the own slot isn't known until the first `session_info`. If the
    // user tapped the mic during that window, _talkMsgIsForUs() discarded our OWN
    // talk_granted because it couldn't be compared, the 3s ran out, and the firmware got blamed.
    //
    // A talk_granted is only sent TO WHOEVER REQUESTED IT, and here it's on record that we requested it
    // (_talkPending). The residual risk -- that the relay broadcasts another client's grant when that client
    // requested the turn at that exact same instant -- is knowingly accepted, because what the filter
    // prevented here was NOT opening the mic: once the 3s ran out it opened anyway, just later and
    // blaming the user's firmware. It protected nothing, and it lied.
    //
    // The slot is NOT adopted from this message: it's set by `session_info`, which IS unambiguously
    // ours. Until then, _reconcileTalkTurn() already withholds any opinion.
    const oursByRequest = this._talkPending && this._slot === null;
    if (msg && !this._talkMsgIsForUs(msg) && !oursByRequest) return;
    // NEVER open the mic without the user having requested it. A talk_granted that isn't a reply to
    // one of our own talk_requests can be (a) the reconfirmation of a turn we already had
    // (§1.4-ter: repeating talk_request is the natural way to say "I'm still here"), or (b) - over the
    // REMOTE path - a message meant for ANOTHER session: the relay is a forwarder that fans out to ALL
    // clients connected to that device_id (§3.2, verified in relay.py), so a remote
    // client can receive messages that aren't its own. Opening someone's microphone because of a
    // message meant for someone else would be a privacy failure, not just a UI bug.
    if (!this._talkPending) {
      if (this.talkActive) { this._talkHeld = true; this._talkGrantedAt = performance.now(); }
      return;
    }
    if (this._talkTimer) { clearTimeout(this._talkTimer); this._talkTimer = null; }
    this._talkHeld = true;
    this._talkGrantedAt = performance.now();
    this._talkPending = false;
    this._startTalk();
  }

  _handleTalkDenied(msg) {
    // Same reasoning as in _handleTalkGranted: with no own request in flight, this isn't
    // ours (relay fan-out) - ignore it instead of closing the user's mic.
    if (msg && !this._talkMsgIsForUs(msg)) return;
    if (!this._talkPending) return;
    if (this._talkTimer) { clearTimeout(this._talkTimer); this._talkTimer = null; }
    this._talkPending = false;
    this._talkHeld = false;
    console.warn(`[ig-doorbell-card] talk turn denied by the device (reason=${(msg && msg.reason) || 'no reason given'})`);
    // HONEST intermediate state, not a silent failure: the speaker gets unmuted (the doorbell CAN
    // BE HEARD) but the mic stays closed, and it says why. Without this state, "busy" would be
    // a button that does nothing.
    this._enterListenOnly();
    this._flashStatusLine('talk_denied_msg', 5000);
  }

  // talk_state reaches ALL clients on every change. It's also how the device reports
  // that it has TAKEN the turn away from us on its own - having your mic cut mid-sentence with no
  // explanation would be exactly the silent failure to avoid. Real deadlines after the contract
  // adjustment of 2026-07-26: 60s of ABSOLUTE silence if the turn was requested with talk_request (what this
  // card does), and only 5s for whoever took it implicitly by talking without requesting it - i.e., this same
  // card when it talks against a doorbell with older firmware (_talkUnsupported). That asymmetry
  // is exactly why it's worth requesting the turn explicitly.
  _reconcileTalkTurn() {
    // Retry after a talk_denied: the device ALWAYS pushes talk_state{talker:-1} once the
    // channel becomes free (2026-07-26 contract adjustment), so the user can be notified
    // at the exact moment they can talk, instead of leaving them guessing blindly. The mic is NOT
    // reopened on its own: the user asked to talk a while ago and might not still be there -
    // opening their microphone without them tapping again would be an unpleasant surprise, not a
    // convenience.
    if (this._listenOnly && this._talkerSlot < 0 && !this._talkFreeHintShown) {
      this._talkFreeHintShown = true;
      this._flashStatusLine('talk_free_retry', 5000);
    }
    if (this._talkerSlot >= 0) this._talkFreeHintShown = false; // rearms the notice for next time

    if (!this.talkActive) { this._paintMicState(); return; }
    if (this._slot === null) { this._paintMicState(); return; } // with no own slot nothing can be asserted
    if (this._talkerSlot === this._slot) { this._paintMicState(); return; }
    // Anti-race grace period: an "old" talk_state (emitted right before our talk_granted)
    // must not close the mic we just opened.
    if (performance.now() - this._talkGrantedAt < 1500) return;

    const takenByOther = this._talkerSlot >= 0;
    this._talkHeld = false;
    this._enterListenOnly();
    this._flashStatusLine(takenByOther ? 'talk_taken' : 'talk_silence', 5000);
  }

  // The doorbell can be heard, but with no mic. Reuses the same mic-closing path as
  // _stopTalk() to avoid duplicating the replaceTrack/stop-tracks logic.
  _enterListenOnly() {
    this._closeMicHardware();
    this.talkActive = false;
    this._listenOnly = true;
    // Turn denied: the mic closes but you KEEP HEARING. This is exactly the independence
    // between listening and talking that §1.10 calls for, and the user already made the gesture (tapped the mic).
    this._setAudioOn(true, 'listen-only');
    this._setLiveState('live');
    if (this.audioPill) this.audioPill.style.display = 'none';
    this._paintMicState();
    this._updateMotionPill();
  }

  // Renders the mic button according to the turn's real state. A single place that decides
  // icon/class/label, so they can't drift out of sync across the 6 paths that touch it.
  _paintMicState() {
    if (!this.micButton) return;
    const btn = this.micButton;
    btn.classList.toggle('active-talk', !!this.talkActive);
    btn.classList.toggle('requesting', !!this._talkPending);
    btn.classList.toggle('listen-only', !!this._listenOnly);
    // "Busy with someone else" = someone has the turn and it isn't us. It does NOT disable the button
    // on purpose (you can tap it and get an explicit talk_denied with its notice) - a button
    // disabled by a remote state is exactly the "stuck forever" outcome to avoid if
    // the release notice got lost.
    const busyByOther = this._talkerSlot >= 0 && this._slot !== null && this._talkerSlot !== this._slot;
    btn.classList.toggle('busy-other', !!busyByOther && !this.talkActive);
    btn.title = busyByOther && !this.talkActive ? getLocalText(this._hass, 'talk_busy') : '';

    if (this.micIcon) {
      this.micIcon.setAttribute('icon',
        this._talkPending ? 'mdi:microphone-question'
          : this.talkActive ? 'mdi:microphone'
            : this._listenOnly ? 'mdi:ear-hearing'
              : 'mdi:microphone-off');
    }
    if (this.micLabel) {
      const key = this._talkPending ? 'talk_requesting'
        : this.talkActive ? 'lbl_mic_on'
          : this._listenOnly ? 'lbl_mic_listen'
            : 'lbl_mic_off';
      this.micLabel.textContent = getLocalText(this._hass, key);
      this.micLabel.classList.toggle('on-cyan', !!this.talkActive);
      this.micLabel.classList.toggle('on-amber', !!this._listenOnly || !!this._talkPending);
    }
  }

  // ==============================================================================
  // MULTI-CLIENT: CLIENT COUNTER (API_CONTRACT.md §1.4-ter #2, session_info message)
  // Counts ONLY WebRTC sessions - RTSP/NVR clients don't show up here on purpose (they're
  // third-party recorders, not people watching).
  // ==============================================================================
  _handleSessionInfo(msg) {
    if (typeof msg.clients === 'number') this._clients = msg.clients;
    if (typeof msg.talker === 'number') this._talkerSlot = msg.talker;
    // Lock type, since 2026-07-29. Arrives on every session_info (~4s), so a change
    // made on the doorbell's dashboard while this card is open is reflected without reconnecting. It only
    // repaints when it actually changes: this runs several times a minute.
    if (typeof msg.door_m === 'number' && msg.door_m !== this._doorMode) {
      this._doorMode = msg.door_m;
      this._applyDoorAvailability();
    }
    // Image rotation (§1.9, 2026-07-30). Travels here for the same reason as `door_m`: it's what
    // lets a client that opens video straighten the image without asking for anything else - `get_states`
    // also carries it, but requires an admin cookie, which a paired card doesn't have.
    // _applyRotation() bails out on its own if it hasn't changed: this runs several times a minute.
    if (typeof msg.rot === 'number') this._applyRotation(msg.rot);
    this._paintClients();
    this._reconcileTalkTurn();
  }

  _paintClients() {
    if (!this.clientsPill) return;
    if (this._clients === null) { this.clientsPill.style.display = 'none'; return; }
    this.clientsPill.style.display = 'flex';
    this.clientsCount.textContent = String(this._clients);
    // Highlighted only when there's MORE than one: "someone else is watching" is the fact that changes how
    // you behave; "you're alone" is the normal case and shouldn't draw attention.
    this.clientsPill.classList.toggle('multi', this._clients > 1);
  }

  // ==============================================================================
  // MULTI-CLIENT: PER-RECIPIENT QUALITY (API_CONTRACT.md §1.4-ter #3)
  //
  // Capability probe: as soon as the session is negotiated, {"type":"quality","mode":"auto"} is sent.
  // It serves two purposes at once: (1) leaving the session on 'auto' from the start (the
  // device starts every slot on 'full', and 'auto' is what we want by default so that the
  // day the firmware consumes RTCP RR it can degrade on its own without the user touching anything), and
  // (2) finding out, WITHOUT the user having to tap anything, whether this firmware understands the message.
  // The selector is only shown if quality_state comes back. One retry before giving
  // up, because the contract warns that status notices can be dropped if that
  // session's outgoing queue is full.
  // ==============================================================================
  _probeQualitySupport() {
    this._qualityProbeAttempts = 0;
    this._quality = 'auto';
    this._sendQuality('auto');
  }

  _sendQuality(mode) {
    this._quality = mode;
    this.sendNativeSignal({ type: 'quality', mode });
    if (this._qualityProbeTimer) { clearTimeout(this._qualityProbeTimer); this._qualityProbeTimer = null; }
    if (this._qualitySupported === true) {
      this._paintQuality();
      return;
    }
    this._qualityProbeTimer = setTimeout(() => {
      this._qualityProbeTimer = null;
      if (this._qualitySupported === true) return;
      this._qualityProbeAttempts += 1;
      if (this._qualityProbeAttempts < 2) {
        this._sendQuality(mode);
        return;
      }
      this._qualitySupported = false;
      this._paintQuality();
      // No UI notice on purpose: the only path that reaches here is the automatic startup
      // probe (once _qualitySupported is true the selector appears and this timer no longer
      // gets armed; while it isn't, the selector stays hidden and the user can't request anything). A
      // doorbell with older firmware works perfectly fine without this feature - bothering the
      // user with a notice about something they never asked for would be noise, not information.
      console.warn('[ig-doorbell-card] the device did not confirm any quality_state after 2 attempts - firmware predating the quality contract (2026-07-26): the quality selector is not shown in this session');
    }, 4000);
  }

  _handleQualityState(msg) {
    if (this._qualityProbeTimer) { clearTimeout(this._qualityProbeTimer); this._qualityProbeTimer = null; }
    this._qualitySupported = true;
    if (typeof msg.mode === 'string' && msg.mode !== this._qualityEffective) {
      this._qualityEffective = msg.mode;
      // The life watchdog switches counters (video <-> audio) depending on the effective mode, see
      // _checkLifeWatchdog(): the previous baseline belongs to ANOTHER counter, so comparing them
      // would give a false "not progressing". The measurement is reset and the change itself counts as a
      // life signal (a message from the device just arrived, so by definition it's alive).
      this._prevPacketsReceived = null;
      this._recordLifeSignal();
    }
    // If the device has decided on its own (auto_loss/auto_bandwidth), the mode the user requested
    // does NOT change (it stays on 'auto'): what changes is the EFFECTIVE mode. An unexplained
    // quality change is perceived as a bug, so the reason is stated.
    const reason = msg.reason;
    if (reason === 'auto_loss' || reason === 'auto_bandwidth') {
      this._flashStatusLine(reason === 'auto_loss' ? 'q_auto_loss' : 'q_auto_bw', 6000);
    }
    this._paintQuality();
  }

  _renderQualityMenu() {
    if (!this.qualityMenu) return;
    this.qualityMenu.innerHTML = QUALITY_MODES.map((m) => (
      `<button type="button" class="q-opt" data-mode="${m.wire}"><ha-icon icon="${m.icon}"></ha-icon>` +
      `<span class="q-txt"><b>${getLocalText(this._hass, m.key)}</b><i>${getLocalText(this._hass, m.sub)}</i></span></button>`
    )).join('');
    this.qualityMenu.querySelectorAll('.q-opt').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this._toggleQualityMenu(false);
        const mode = btn.getAttribute('data-mode');
        this._sendQuality(mode);
        // Explicit notice when turning on "Low": ~1 frame/s is perceived as a malfunction if nobody has
        // said that's what's expected (same criterion as the Android app). Only when TURNING IT ON, not on
        // every repaint.
        if (mode === 'low') this._flashStatusLine('q_low_warn', 6000);
      });
    });
  }

  _toggleQualityMenu(force) {
    const open = (typeof force === 'boolean') ? force : !this._qualityMenuOpen;
    this._qualityMenuOpen = open;
    if (this.qualityMenu) this.qualityMenu.style.display = open ? 'flex' : 'none';
  }

  _paintQuality() {
    if (!this.qualityCtl) return;
    this.qualityCtl.style.display = this._qualitySupported === true ? 'block' : 'none';
    if (this._qualitySupported !== true) { this._toggleQualityMenu(false); return; }
    // The REQUESTED mode is shown, and if the one confirmed by the device is different (today
    // this can only happen with 'auto', which behaves like 'full', or when auto-degrade
    // kicks in on its own in the future) it's added in parentheses: the card must never claim you're seeing
    // something different from what the device says it's sending.
    const req = qualityModeMeta(this._quality) || QUALITY_MODES[0];
    const eff = qualityModeMeta(this._qualityEffective);
    const showEff = eff && this._quality === 'auto' && this._qualityEffective !== 'auto';
    if (this.qualityIcon) this.qualityIcon.setAttribute('icon', req.icon);
    if (this.qualityLabel) {
      this.qualityLabel.textContent = showEff
        ? `${getLocalText(this._hass, req.key)} · ${getLocalText(this._hass, eff.key)}`
        : getLocalText(this._hass, req.key);
    }
    this.qualityMenu.querySelectorAll('.q-opt').forEach((btn) => {
      btn.classList.toggle('sel', btn.getAttribute('data-mode') === this._quality);
    });
  }

  // PER-SESSION state: the talk turn and quality live on the device per slot, and a
  // new session always starts with no turn and on 'full'. Inheriting either one from the
  // previous session would be lying about the other end's real state.
  //
  // `_doorMode` is NOT reset here, and it's deliberate: it's not session state but the doorbell's
  // CONFIGURATION, which doesn't change because the connection drops. Forgetting it on every reconnection would
  // make the open button reappear for a few seconds on a doorbell with no lock, every time - exactly the
  // flicker this mechanism exists to prevent. If it has genuinely changed, the new session's
  // first session_info corrects it.
  _resetMulticlientState() {
    if (this._talkTimer) { clearTimeout(this._talkTimer); this._talkTimer = null; }
    if (this._qualityProbeTimer) { clearTimeout(this._qualityProbeTimer); this._qualityProbeTimer = null; }
    this._talkHeld = false;
    this._talkPending = false;
    this._talkGrantedAt = 0;
    // _talkUnsupported / _qualitySupported are also reset on purpose: if the user
    // updates the firmware, the device restarts and the card reconnects - re-probing on every
    // new session is what lets the card find out on its own, without reloading the browser. The cost
    // is at most a 3s wait the first time the mic gets tapped against an old doorbell.
    this._talkUnsupported = false;
    this._listenOnly = false;
    this._talkFreeHintShown = false;
    this._talkerSlot = -1;
    this._clients = null;
    this._quality = 'auto';
    this._qualityEffective = null;
    this._qualitySupported = null;
    this._qualityProbeAttempts = 0;
    this._paintClients();
    this._paintQuality();
  }

  // ==============================================================================
  // FULL SCREEN (2026-07-29). See the comment block for
  // nativeFullscreenAvailable() above for WHY there are two levels and where
  // each real case comes from.
  //
  // Contract rules implemented here that must NOT be "improved" later without rereading it:
  //  - The controls do NOT hide themselves. This isn't a video player: there's someone
  //    waiting at the door, and having the open button vanish after 3 seconds is
  //    exactly the moment nobody wants to hunt for anything. (There's nothing to code here:
  //    there's simply no hide timer at all. It's left written down so nobody
  //    mistakes it for an oversight.)
  //  - The screen doesn't turn off while the mode is active (wake lock).
  //  - The viewer count stays visible.
  //  - The open button only appears if a lock is configured.
  // ==============================================================================
  // The listeners are on the DOCUMENT, not the element, so they have to be removed on leaving the DOM
  // (disconnectedCallback does it) and re-added on re-entering - Home Assistant remounts
  // cards when switching views or editing the dashboard, and render() doesn't run again in that
  // case (it's guarded by `if (!this.content)`). That's why this also gets called by
  // connectedCallback and not just render(): otherwise, exiting with ESC would stop working after the
  // first remount, silently.
  _registerFullscreenListeners() {
    if (this._onFsChange) return; // already registered
    this._onFsChange = () => this._syncFullscreenFromBrowser();
    document.addEventListener('fullscreenchange', this._onFsChange);
    document.addEventListener('webkitfullscreenchange', this._onFsChange);
    this._onFsKeyDown = (ev) => {
      // In NATIVE fullscreen, ESC is handled by the browser (and it notifies us via
      // 'fullscreenchange'); here it's only needed for our own fallback, which has no exit
      // from the browser. Same gesture in both, which is what the contract requires.
      if (ev.key === 'Escape' && this._fsActive && !this._fsNative) this._exitFullscreen();
    };
    document.addEventListener('keydown', this._onFsKeyDown);
  }

  _toggleFullscreen() {
    if (this._fsActive) this._exitFullscreen();
    else this._enterFullscreen();
  }

  async _enterFullscreen() {
    if (this._fsActive) return;

    // Level 1: the real API. It's requested on the card's OWN element (not on the <video>): in
    // native fullscreen the element moves to the browser's "top layer", so it
    // jumps past any `overflow:hidden` or Home Assistant container without depending on anything from the
    // dashboard - and it keeps our buttons on top, which is exactly what iOS's native player
    // would NOT do. ESC is handled by the browser and it notifies us via 'fullscreenchange'.
    if (nativeFullscreenAvailable()) {
      const req = this.requestFullscreen || this.webkitRequestFullscreen;
      try {
        // `navigationUI:'hide'` is a suggestion; browsers that don't understand it ignore it.
        await req.call(this, { navigationUI: 'hide' });
        this._fsNative = true;
        this._fsActive = true;
        this._applyFullscreenUI();
        this._acquireWakeLock();
        return;
      } catch (err) {
        // It can reject even if `fullscreenEnabled` says yes (e.g. if the browser doesn't
        // consider there to have been a user gesture). It's not fatal: it falls back to level 2, which
        // works just as well inside the window.
        console.warn('[ig-doorbell-card] native fullscreen rejected, falling back to our own CSS fallback', err);
      }
    }

    // Level 2: our own fallback, `position:fixed` on the card's container.
    this._fsNative = false;
    this._fsActive = true;
    this._applyFullscreenUI();

    // And now it's CHECKED that it has really filled the window, instead of assuming it. An
    // ancestor with transform/filter/perspective/contain:paint turns any descendant
    // position:fixed relative TO THAT ANCESTOR (standard CSS behavior, not a browser
    // bug), and in Home Assistant a theme, card-mod, or the side drawer itself can
    // introduce one without the card knowing.
    if (this._fallbackFillsWindow()) { this._acquireWakeLock(); return; }

    // ...and if it's trapped, it does NOT give up: the container gets pulled out to <body>, where by
    // definition there's no ancestor that can trap it, and it measures again.
    //
    // This fixes a REAL bug on the user's iPhone (2026-07-29): the icon disappeared with
    // normal use. The previous version, when the measurement failed, simply hid the icon
    // FOREVER -- and on top of that, hiding it depended on wherever Home Assistant had placed
    // the card, not on anything the user could understand or change. A feature that
    // disables itself and doesn't say why is worse than one that fails loudly.
    //
    // The CONTAINER moves, never the card's own element: pulling <ig-doorbell-card>
    // out of the DOM would fire disconnectedCallback() and take down the whole WebRTC session. The <video>
    // moves with the container and doesn't get cut off: it keeps its srcObject, and the move is synchronous, so
    // the element is never out of the document when the browser checks whether it
    // should pause it. And since this card doesn't use Shadow DOM, the injected stylesheet keeps
    // applying just the same with the container hanging off <body>.
    //
    // The move only happens once the normal path has already failed: in the ordinary case the DOM
    // isn't touched at all.
    this._mark('fullscreen: the fallback is trapped by an ancestor - moving to <body> and measuring again');
    this._portalToBody();
    if (this._fallbackFillsWindow()) {
      console.info('[ig-doorbell-card] an ancestor was trapping fullscreen; resolved by moving the card to <body>.');
      this._acquireWakeLock();
      return;
    }

    // Not even hanging off <body>. That's no longer "this card in this slot": it means that on this
    // page NO fixed element can fill the window (a transform on <html> or <body>).
    // Here it really is an honest dead end, and the icon gets removed -- but it's a verdict
    // about the PAGE, stable, not something that could change because the user opens the microphone.
    console.warn(
      '[ig-doorbell-card] fullscreen is not possible on this page: not even ' +
      'hanging the container off <body> manages to fill the window. Common cause: a ' +
      'transform/filter/contain applied to <html> or <body> by a theme. Suspicious ancestors: ' +
      JSON.stringify(this._suspiciousAncestors()) + '. The icon is being removed instead of offering a mode that does not work.'
    );
    this._fsActive = false;
    this._applyFullscreenUI();
    this._fsUnavailable = true;
    this._paintFullscreenButton();
  }

  // Compared against a PROBE, not against any viewport measurement: an identical element
  // (position:fixed, inset:0) hung off <body>, measured at the same instant. If the container
  // ends up where the probe ends up, it has escaped.
  //
  // This was arrived at by measuring, after getting it wrong TWICE with measurements that look like the
  // obvious reference and aren't:
  //  - window.innerWidth INCLUDES the scrollbar; a position:fixed element's containing
  //    block does not. Measured on a real Home Assistant: a view with scroll gave 1270x900
  //    against a 1280x900 window -- exact height, width short by exactly the scrollbar's
  //    thickness, and zero risky ancestors.
  //  - documentElement.clientHeight doesn't work either: in quirks mode it returns the DOCUMENT's
  //    height, not the viewport's (measured: 4506px with a window 900px tall).
  _fallbackFillsWindow() {
    const rect = this.content.getBoundingClientRect();
    const probeEl = document.createElement('div');
    probeEl.style.cssText = 'position:fixed;inset:0;visibility:hidden;pointer-events:none;';
    document.body.appendChild(probeEl);
    const ref = probeEl.getBoundingClientRect();
    probeEl.remove();

    // Part 2, and it's not redundant: the probe has a blind spot that was genuinely seen when it
    // was triggered (a transform on <body>). There the probe gets trapped exactly like the
    // container, both measure the same thing, and the comparison says "correct" with a fullscreen
    // that's 64px tall. Comparing the same thing against the same thing detects that the container is where
    // it should be, but not that that place is the window.
    //
    // That's why a SANITY bound is added on top of the probe itself: if a fixed element hung off
    // <body> doesn't even reach 60% of the window, on this page fixed positioning doesn't work for
    // anyone. The 60% is deliberately generous -- it only has to tell "the whole window" apart from "some
    // random box", not measure precisely -- and it's compared against window.innerWidth/Height,
    // which DO work here: the scrollbar is 10-17px and quirks mode doesn't affect them.
    // The two traps that ruined the exact comparison don't come anywhere near this margin.
    const probeIsSane = ref.height >= window.innerHeight * 0.6
      && ref.width >= window.innerWidth * 0.6;

    return probeIsSane
      && Math.abs(rect.width - ref.width) <= 2
      && Math.abs(rect.height - ref.height) <= 2
      && Math.abs(rect.left - ref.left) <= 2
      && Math.abs(rect.top - ref.top) <= 2;
  }

  // Diagnostics for when it fails: names the culprit instead of leaving a "couldn't do it". Meant
  // to be read via remote debugging from the companion app, where there's no DevTools at hand.
  _suspiciousAncestors() {
    const out = [];
    let n = this.content;
    let guard = 0;
    while (n && guard++ < 200) {
      if (n.nodeType === 1) {
        const cs = getComputedStyle(n);
        const offending = {};
        if (cs.transform && cs.transform !== 'none') offending.transform = cs.transform;
        if (cs.filter && cs.filter !== 'none') offending.filter = cs.filter;
        if (cs.perspective && cs.perspective !== 'none') offending.perspective = cs.perspective;
        if (cs.contain && cs.contain !== 'none') offending.contain = cs.contain;
        if (cs.willChange && cs.willChange !== 'auto') offending.willChange = cs.willChange;
        if (Object.keys(offending).length) out.push({ tag: n.tagName.toLowerCase(), ...offending });
      }
      n = n.parentNode || null;
      if (n && n.nodeType === 11) n = n.host;
    }
    return out;
  }

  // Moving the CONTAINER to <body> and back to its place. The next sibling is remembered, not
  // just the parent, so it can be put back exactly where it was.
  _portalToBody() {
    if (this._fsHost) return;
    this._fsHome = { parent: this.content.parentNode, next: this.content.nextSibling };
    this._fsHost = document.createElement('div');
    this._fsHost.className = 'ig-fs-host';
    document.body.appendChild(this._fsHost);
    this._fsHost.appendChild(this.content);
  }

  _undoPortal() {
    if (!this._fsHost) return;
    if (this._fsHome && this._fsHome.parent) {
      this._fsHome.parent.insertBefore(this.content, this._fsHome.next);
    }
    this._fsHost.remove();
    this._fsHost = null;
    this._fsHome = null;
  }

  _exitFullscreen() {
    if (!this._fsActive) return;
    if (this._fsNative && currentFullscreenElement()) {
      // The real repaint is done by _syncFullscreenFromBrowser() when 'fullscreenchange' arrives -
      // that way the "I exit" path and the "the user exits with ESC" path are the SAME code and
      // can't diverge.
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      try { exit.call(document); } catch (err) { /* best effort */ }
      return;
    }
    this._fsActive = false;
    this._fsNative = false;
    this._applyFullscreenUI();
    this._releaseWakeLock();
  }

  // The browser has entered or exited fullscreen on its own (ESC, a system gesture,
  // another tab...). Source of truth: the document itself, never our own variable.
  _syncFullscreenFromBrowser() {
    const fsEl = currentFullscreenElement();
    const weAreFullscreen = (fsEl === this);
    if (weAreFullscreen === (this._fsActive && this._fsNative)) return;
    if (weAreFullscreen) {
      this._fsActive = true;
      this._fsNative = true;
      this._applyFullscreenUI();
      this._acquireWakeLock();
    } else if (this._fsNative) {
      this._fsActive = false;
      this._fsNative = false;
      this._applyFullscreenUI();
      this._releaseWakeLock();
    }
  }

  // A single attribute (`data-fs`) governs ALL the repositioning, for both levels: that way the
  // stylesheet has one single version of the mode instead of two that could drift apart over time.
  // `ig-fs-pseudo` only adds the `position:fixed` that level 1 doesn't need (in native it's set by
  // the browser).
  // The mode classes go on the CONTAINER, not on the card's element, and that's not a detail:
  // when it's necessary to move the container to <body> (see _portalToBody) it stops being a descendant
  // of the element, so any rule hanging off `ig-doorbell-card[data-fs]` would stop
  // applying exactly in the case it's trying to save. The `data-fs` attribute DOES stay on the
  // element: in native fullscreen it's the one the browser resizes.
  _applyFullscreenUI() {
    if (this._fsActive) {
      this.setAttribute('data-fs', '1');
      this.content.classList.add('ig-fs');
      this.content.classList.toggle('ig-fs-pseudo', !this._fsNative);
      // ⚠️ MEASURED ON REAL HARDWARE (2026-09-25, living-room tablet, the official Home Assistant Android
      // app - not Chrome, even though it looks like it from the outside): `requestFullscreen()` IS granted
      // (the system status bar and navigation bar disappear, confirmed with `uiautomator dump`: the
      // WebView fills the full physical 1920x1200) but the content leaves a real BLACK gap
      // of ~210px at the bottom and ~15px at the top - reproducible, stable, not a transition frame
      // (it stays the same past 3s). The only explanation that survives: this stylesheet
      // never sets `position:fixed;inset:0` on the element itself for the NATIVE path (line
      // further below) - it relied on the browser's UA stylesheet setting `:fullscreen` to fill the
      // screen on its own, and in this particular WebView that implicit rule isn't enough (or isn't there). The
      // CSS fallback (level 2, `.ig-fs-pseudo`) DOES set explicit `position:fixed;inset:0` and doesn't
      // have this problem - the class below does the same for native, without touching the
      // fallback. Redundant and harmless on a browser where `:fullscreen` already did it right.
      // CORRECTION 1.9.3, measured: that explanation was false. The cause was the Shadow DOM - see the
      // ⚠️ in currentFullscreenElement(). The class is left in because it doesn't get in the way.
      this.classList.toggle('ig-fs-native-layout', this._fsNative);
      // Locking the document's scroll underneath only makes sense in the fallback (in native
      // the document isn't visible anymore). Without this, a finger on the card on mobile can move the
      // whole dashboard behind it.
      if (!this._fsNative) document.body.classList.add('ig-fs-body-lock');
    } else {
      // Putting the container back in its place BEFORE removing the classes, so that a frame with
      // the card already without the mode styles but still hanging off <body> never gets to be seen.
      this._undoPortal();
      this.removeAttribute('data-fs');
      this.classList.remove('ig-fs-native-layout');
      this.content.classList.remove('ig-fs', 'ig-fs-pseudo');
      document.body.classList.remove('ig-fs-body-lock');
    }
    this._paintFullscreenButton();
    // The zoom resets on entering and leaving: the frame's whole geometry changes, and a crop
    // meant for the panel makes no sense in fullscreen (nor the other way around).
    this._zoomReset();
    // Entering/leaving fullscreen repositions the card, and the IntersectionObserver may say
    // «not visible» during the transition: that is NOT leaving the view (see the observer).
    this._fsTransitionUntil = Date.now() + 2500;
    this._fitToSpace();
    // The frame changes size on entering/leaving, and with the image rotated the video box is
    // computed from that size (§1.9). The ResizeObserver would eventually catch up, but one frame
    // late: recalculating here avoids the flicker. This is also where the side rail appears or
    // disappears, which depends only on the mode.
    this._layoutRotation();
  }

  // ==============================================================================
  // PINCH TO ZOOM (1.9.3, Iñaki 2026-09-25: «where the screen fills up completely and
  // you can use your fingers to zoom into an area»). Two-finger pinch, one-finger drag once
  // already zoomed, and double tap: if zoomed, it snaps back; if not, it zooms x2.5 at that
  // point. Works in fullscreen and also with the card embedded.
  //
  // Pointer Events on the FRAME (.feed-wrap) and transform on .video-wrapper, with origin 0 0:
  // the software rotation (§1.9) lives on the <video> itself (its `style.transform`), so the two
  // transforms compose without stepping on each other. The limits: scale 1..ZOOM_MAX and an offset
  // that never shows outside the zoomed image (the frame always stays covered).
  //
  // What's left untouched: the buttons. A finger that starts on a control (HUD, action row,
  // quality menu) isn't a zoom gesture - it's ignored here and the button gets its normal click.
  //
  // ⚠️ `touch-action` is half the mechanism, not a styling detail. Without `none`, the Home
  // Assistant app's WebView keeps the gesture for itself (it pans the panel or zooms the whole page) and
  // sends us `pointercancel` mid-pinch. In fullscreen, or already zoomed, it's `none`.
  // Embedded and NOT zoomed it's `pan-x pan-y`: a finger on the video has to keep panning the
  // panel, or the card turns into a hole where you can't scroll. For the
  // pinch to stay ours in that case, a two-finger `touchmove` is canceled (non-passive
  // listener): that stops the browser from starting to pan, and therefore from canceling the pointers.
  // ==============================================================================
  _setupZoom() {
    if (this._zoomReady || !this.feedWrap) return;
    this._zoomReady = true;
    this._zoomEl = this.querySelector('.video-wrapper');
    this._zoom = { s: 1, x: 0, y: 0 };
    this._zPtrs = new Map();
    this._zGesture = null;
    this._zLastTap = null;
    const fw = this.feedWrap;
    const isControl = (t) => !!(t && t.closest && t.closest('button, a, input, select, .hud-top, .hud-bottom, .actions-row, .status-line'));
    const pointOf = (ev) => { const r = fw.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; };

    fw.addEventListener('pointerdown', (ev) => {
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      if (isControl(ev.target)) return;
      this._zPtrs.set(ev.pointerId, pointOf(ev));
      try { fw.setPointerCapture(ev.pointerId); } catch (err) { /* pointer already released */ }
      this._zStartGesture();
      if (this._zPtrs.size === 1) this._zDown = { ...pointOf(ev), t: Date.now(), moved: false };
    });
    fw.addEventListener('pointermove', (ev) => {
      if (!this._zPtrs.has(ev.pointerId)) return;
      this._zPtrs.set(ev.pointerId, pointOf(ev));
      if (this._zDown) {
        const p = pointOf(ev);
        if (Math.hypot(p.x - this._zDown.x, p.y - this._zDown.y) > 10) this._zDown.moved = true;
      }
      this._zApplyGesture();
    });
    const onPointerEnd = (ev) => {
      if (!this._zPtrs.has(ev.pointerId)) return;
      this._zPtrs.delete(ev.pointerId);
      if (ev.type === 'pointerup' && this._zPtrs.size === 0 && this._zDown && !this._zDown.moved
          && (Date.now() - this._zDown.t) < 300 && !this._zWasMulti) {
        const p = pointOf(ev);
        const prev = this._zLastTap;
        if (prev && (Date.now() - prev.t) < 350 && Math.hypot(p.x - prev.x, p.y - prev.y) < 40) {
          this._zLastTap = null;
          this._zDoubleTap(p);
        } else {
          this._zLastTap = { x: p.x, y: p.y, t: Date.now() };
        }
      }
      if (this._zPtrs.size === 0) { this._zDown = null; this._zWasMulti = false; }
      this._zStartGesture();
    };
    fw.addEventListener('pointerup', onPointerEnd);
    fw.addEventListener('pointercancel', onPointerEnd);
    // See the ⚠️ above: with two fingers the gesture is ours even if the card is embedded.
    fw.addEventListener('touchmove', (ev) => {
      if (ev.touches && ev.touches.length >= 2 && ev.cancelable) ev.preventDefault();
    }, { passive: false });
    // Wheel with Ctrl (a trackpad pinch on desktop): same zoom, centered on the cursor.
    fw.addEventListener('wheel', (ev) => {
      if (!ev.ctrlKey) return;
      ev.preventDefault();
      const p = pointOf(ev);
      this._zZoomAt(this._zoom.s * Math.exp(-ev.deltaY / 200), p.x, p.y);
    }, { passive: false });
    this._zPaint();
  }

  // Every time the number of fingers changes, a new snapshot of the gesture is taken: that way lifting one of
  // the two mid-pinch doesn't cause a jump.
  _zStartGesture() {
    const pts = [...this._zPtrs.values()];
    if (pts.length >= 2) this._zWasMulti = true;
    if (pts.length === 0) { this._zGesture = null; this._zPaint(); return; }
    const a = pts[0], b = pts[1] || null;
    const c = b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : { x: a.x, y: a.y };
    this._zGesture = {
      c, d: b ? Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) : 0,
      s: this._zoom.s, x: this._zoom.x, y: this._zoom.y,
    };
    this._zPaint();
  }

  _zApplyGesture() {
    const g = this._zGesture;
    if (!g) return;
    const pts = [...this._zPtrs.values()];
    if (pts.length === 0) return;
    const a = pts[0], b = pts[1] || null;
    const c = b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : { x: a.x, y: a.y };
    // One finger while not zoomed moves nothing (embedded, the browser is panning the panel).
    if (!b && g.s <= 1.001) return;
    let s = g.s;
    if (b && g.d) s = g.s * (Math.hypot(a.x - b.x, a.y - b.y) / g.d);
    s = Math.min(ZOOM_MAX, Math.max(1, s));
    // The point of the image that was under the gesture's center stays under the current center.
    const ix = (g.c.x - g.x) / g.s, iy = (g.c.y - g.y) / g.s;
    this._zoom = { s, x: c.x - ix * s, y: c.y - iy * s };
    this._zoomClamp();
  }

  _zZoomAt(s, px, py) {
    s = Math.min(ZOOM_MAX, Math.max(1, s));
    const z = this._zoom;
    const ix = (px - z.x) / z.s, iy = (py - z.y) / z.s;
    this._zoom = { s, x: px - ix * s, y: py - iy * s };
    this._zoomClamp();
  }

  _zDoubleTap(p) {
    if (this._zoom.s > 1.01) this._zoomReset();
    else this._zZoomAt(2.5, p.x, p.y);
  }

  _zoomReset() {
    if (!this._zoom) return;
    this._zoom = { s: 1, x: 0, y: 0 };
    this._zPaint();
  }

  // The frame always covered: with origin 0 0 and scale s, x ranges from w*(1-s) to 0 (same for y).
  _zoomClamp() {
    if (!this._zoom || !this.feedWrap) return;
    const w = this.feedWrap.clientWidth, h = this.feedWrap.clientHeight;
    const z = this._zoom;
    if (z.s <= 1.001) {
      this._zoom = { s: 1, x: 0, y: 0 };
    } else {
      z.x = Math.min(0, Math.max(w * (1 - z.s), z.x));
      z.y = Math.min(0, Math.max(h * (1 - z.s), z.y));
    }
    this._zPaint();
  }

  _zPaint() {
    if (!this._zoomEl || !this._zoom) return;
    const z = this._zoom;
    const zoomedIn = z.s > 1.001;
    this._zoomEl.style.transform = zoomedIn ? `translate(${z.x}px, ${z.y}px) scale(${z.s})` : '';
    // See the ⚠️ in _setupZoom: zoomed or in fullscreen, the gesture is entirely ours.
    const ownGesture = zoomedIn || this._fsActive || (this._zPtrs && this._zPtrs.size >= 2);
    this.feedWrap.style.touchAction = ownGesture ? 'none' : 'pan-x pan-y';
    this.feedWrap.classList.toggle('ig-zoomed', zoomedIn);
  }

  _paintFullscreenButton() {
    if (!this.fsBtn) return;
    if (this._fsUnavailable) { this.fsBtn.style.display = 'none'; return; }
    this.fsBtn.style.display = '';
    const key = this._fsActive ? 'fs_exit' : 'fs_enter';
    this.fsBtn.setAttribute('title', getLocalText(this._hass, key));
    this.fsIcon.setAttribute('icon', this._fsActive ? 'mdi:fullscreen-exit' : 'mdi:fullscreen');
    this.fsBtn.classList.toggle('on', this._fsActive);
  }

  // Wake lock: the screen doesn't turn off for as long as the mode lasts. Best-effort on
  // purpose - it's not on every browser, it requires a secure context, and the system can
  // revoke it. Its failure must not prevent fullscreen, only mean the screen turns off
  // as usual.
  async _acquireWakeLock() {
    if (this._wakeLock || !navigator.wakeLock) return;
    try {
      this._wakeLock = await navigator.wakeLock.request('screen');
      // The system revokes it when minimizing the app or switching tabs; it has to be requested again
      // on returning or the screen would turn off mid-conversation the second time around.
      this._wakeLock.addEventListener('release', () => { this._wakeLock = null; });
      // ⚠️ THIS LINE IS NO LONGER WHERE THE COUNTDOWN IS BORN, AND IT CAN'T GO BACK TO BEING THAT.
      //
      // It was until 2026-09-07, and it cost THREE versions in a row (v1.5.0, v1.5.1, v1.6.0) that
      // failed identically on the wallpanel: `_acquireWakeLock()` is only invoked from the
      // FULLSCREEN paths (_enterFullscreen / _syncFullscreenFromBrowser), so a
      // panel that shows the dashboard without entering fullscreen NEVER armed the clock
      // -- and on top of that it bailed out on this function's first line if the webview didn't have
      // `navigator.wakeLock`. Measured on Chromium with the deadline at 4 s and eight seconds of total
      // stillness: the clock never got armed once. The deadline logic was fine; what didn't
      // exist was the clock.
      //
      // Now the countdown gets armed by whatever genuinely justifies it: there being a session (startWebRTC) and
      // there being video (setupRemoteStream). This stays just in case -- rearming is idempotent and the
      // deadline is absolute, so it doesn't hand out extra time -- but it's no longer what it hangs on.
      this._armIdleWakeLockTimer();
      if (!this._onVisibilityForWakeLock) {
        this._onVisibilityForWakeLock = () => {
          if (document.visibilityState === 'visible' && this._fsActive) this._acquireWakeLock();
        };
        document.addEventListener('visibilitychange', this._onVisibilityForWakeLock);
      }
    } catch (err) {
      console.warn('[ig-doorbell-card] could not keep the screen awake (wake lock)', err);
    }
  }

  // ── Releasing the screen on idle ──────────────────────────────────────────────────────
  //
  // Listened for on the card ITSELF, not on `document`: a tap elsewhere on the panel isn't looking at
  // the doorbell, and counting it would keep the screen on for something unrelated.
  // `pointerdown` covers finger and mouse; `keydown` goes on document because the keyboard has no position.
  // ⚠️ `reiniciar` DISTINGUISHES THE TWO CALLS, AND CONFUSING THEM BROKE THIS ENTIRELY (2026-09-06).
  //
  // This countdown measures **time with nobody touching it**, and until now it restarted every time
  // the wake lock was acquired -- i.e. on every (re)connection of the stream. Measured on the tablet via the
  // HASS session: with `idle_release_seconds: 15` it worked and with `60` it NEVER fired, because
  // the stream renegotiates around 30-45 s and reset the count back to zero. With 15 there was time to
  // fire before the first reconnect; with 60, never.
  //
  // What made it hard to see is that the symptom depended on the CONFIGURED VALUE, so it looked
  // like «it works with 15 and not with 60» -- which reads as a duration problem, not a trigger one.
  //
  // Only interaction restarts it. The stream's lifecycle arms the countdown if none existed,
  // but doesn't touch it if one is already running.
  _armIdleWakeLockTimer(restartClock = false) {
    if (restartClock) LAST_INTERACTION_MS = Date.now();
    this._clearIdleWakeLockTimer();
    const timeoutMs = this._idleTimeoutMs();
    this._appliedIdleTimeoutMs = timeoutMs;
    if (!timeoutMs) return;                               // 0 = disabled (phones)
    this._registerIdleActivityListeners();
    // The deadline is ABSOLUTE from the last real interaction, not from this call. Rearming it doesn't
    // hand out extra time, and a newly created instance inherits whatever genuinely remains.
    const secondsLeft = timeoutMs - (Date.now() - LAST_INTERACTION_MS);
    this._idleWakeLockTimer = setTimeout(() => {
      this._idleWakeLockTimer = null;
      // ⚠️ THE GUARD AGAINST FALSE TRIGGERS, AND IT GOES IN HERE ON PURPOSE (2026-09-07).
      //
      // What's costly about this function isn't that it fails to release: it's that it releases when it
      // shouldn't. Cutting the video in the face of someone who's actually watching is a much worse bug
      // than leaving the screen on for too long, and it's also the kind that doesn't reproduce by
      // counting seconds.
      //
      // And the failure mode is real, not theoretical: the deadline is ABSOLUTE from `LAST_INTERACTION_MS`,
      // but the timer was computed with the value from a while ago. Any path that
      // updates the mark without rearming (and until today _onIdleActivity() was exactly that when
      // there was no wake lock) leaves this trigger pointing at a time that's no longer the right one.
      //
      // So instead of trusting the clock, the data is checked again: if there's still time left, nothing
      // gets released and it rearms with whatever genuinely remains. A clock that arms too early is
      // free; one that fires too early isn't. This check is what makes "arming the countdown in more places" safe.
      const timeoutNowMs = this._idleTimeoutMs();
      const remainingMs = timeoutNowMs - (Date.now() - LAST_INTERACTION_MS);
      if (!timeoutNowMs) return;                        // it was disabled while it was running
      if (remainingMs > 0) {
        this._armIdleWakeLockTimer();
        return;
      }
      // ⚠️ NEVER WITH A CALL IN PROGRESS (§1.4-bis "Live pause": "Never pause while a call is
      // active"). Mic open, turn granted or requested: talking to whoever's at the door without
      // touching the screen is exactly the normal case, and cutting it would be the worst possible bug in this
      // feature. It counts as interaction and gets checked again after a full deadline.
      if (this._callActive()) {
        LAST_INTERACTION_MS = Date.now();
        this._armIdleWakeLockTimer();
        return;
      }
      // ⚠️ RELEASING THE WAKE LOCK ISN'T ENOUGH, AND v1.4.0 STOPPED RIGHT THERE (2026-09-06).
      //
      // Measured on the tablet: with the card visible and NOBODY touching it, at 2m22s
      // `SCREEN_BRIGHT_WAKE_LOCK` and `PARTIAL_WAKE_LOCK 'AudioMix'` were still held, and the screen never
      // turned off -- with `screen_off_timeout` at 60 s.
      //
      // The reason: **a playing `<video>` keeps the screen on all by itself**.
      // It's an implicit browser keep-awake, independent of `navigator.wakeLock`, so
      // releasing our own changes nothing while video is running. That's why hiding the card DID
      // work (that stops the video) and staying put did NOT.
      //
      // The correct action once the wait runs out is the SAME as on hiding: release the whole
      // stream. And it's also what Inaki genuinely asked for -- «turn off the screen AND stop consuming
      // the stream», not just the first part.
      if (!this.pc && !this._reconnecting) return;
      this._pause('idle');
    }, Math.max(0, secondsLeft));
  }

  // The current deadline, in ms. Set by the integration's entity (an automation can change it);
  // the YAML's `idle_release_seconds` only if the integration is older and doesn't offer it.
  _idleTimeoutMs() {
    const ent = this._connInfo && this._connInfo.live_timeout_entity;
    const st = ent && this._hass && this._hass.states ? this._hass.states[ent] : null;
    const v = st ? Number(st.state) : NaN;
    if (Number.isFinite(v) && v >= 0) return v * 1000;
    return this._idleReleaseMs;
  }

  _callActive() {
    return !!(this.talkActive || this._talkHeld || this._talkPending);
  }

  // If an automation changes the deadline while the card is open, it applies right away (rearming is cheap and
  // the deadline is absolute, so it doesn't hand out extra time).
  _watchIdleTimeout() {
    if (!this.pc || this._pauseState) return;
    const timeoutMs = this._idleTimeoutMs();
    if (timeoutMs !== this._appliedIdleTimeoutMs) this._armIdleWakeLockTimer();
  }

  // A SINGLE pause for both rules (1.9.1). `live_pause` RIGHT AWAY; `bye` after the grace period unless a
  // call is in progress. See IDLE_GRACE_MS and Iñaki's rule in _registerVisibilityStreamHandler.
  _pause(reason) {
    if (this._destroyed) return;  // (1.10.0) instance of a doorbell that's no longer being viewed: see _destroy()
    if (this._pauseState) {
      // An idle pause doesn't degrade to "hidden": it would still be a person's.
      return;
    }
    const inCall = this._callActive();
    const micOpen = !!(this.talkActive || this._talkHeld || this._talkPending);
    this._clearIdleWakeLockTimer();
    this._clearOffscreenTimer();
    if (!this.pc) {
      // Nothing alive (or a startup in flight): everything gets cut and it stays in a hung-up pause.
      this._clearReconnectTimer();
      this._reconnecting = false;
      this._teardownConnectionObjects();
      this._pauseState = { reason, phase: 'hung_up', micOpen: false };
      if (reason === 'idle') PAUSED_BY_DOORBELL[this.config.device_id] = true;
      this._paintPause();
      return;
    }
    console.info(`[ig-doorbell-card] pause (${reason})${inCall ? ' with a call: not hanging up' : ''}`);
    this._pauseState = { reason, phase: 'grace', micOpen };
    if (reason === 'idle') PAUSED_BY_DOORBELL[this.config.device_id] = true;
    // The mic doesn't stay open with the view closed (and the doorbell releases the turn with
    // live_pause anyway, §1.4-bis). It's remembered so it can be reopened on return.
    if (micOpen) this._stopTalk();
    this._sendLivePause(true);
    // Stopping the <video> releases the browser's implicit keep-awake: the screen can turn off now.
    if (this.videoEl) { try { this.videoEl.pause(); } catch (err) { /* best effort */ } }
    this._releaseWakeLock();
    this._paintPause();
    if (this._pauseGraceTimer) clearTimeout(this._pauseGraceTimer);
    this._pauseGraceTimer = null;
    if (!inCall) this._pauseGraceTimer = setTimeout(() => this._hangUpPaused(), this._idleGraceMs);
    else this._pauseGraceTimer = setTimeout(() => this._hangUpPaused(), CALL_HIDDEN_MAX_MS);
  }

  _hangUpPaused() {
    this._pauseGraceTimer = null;
    if (!this._pauseState || this._pauseState.phase !== 'grace') return;
    this._pauseState.phase = 'hung_up';
    // ⚠️ CLOSING THE PEER ISN'T ENOUGH: THE <video> HAS TO BE RELEASED TOO (measured 2026-09-07, dumpsys power).
    if (this.videoEl) {
      try { this.videoEl.pause(); } catch (err) { /* best effort */ }
      this.videoEl.srcObject = null;
    }
    this._clearReconnectTimer();
    this._reconnecting = false;
    this._teardownConnectionObjects();    // sends `bye`: the slot is released NOW, not after 20 s
    this._paintPause();
  }

  // Coming back: a tap, a ring, or (only for the "hidden" one) returning to the view. Within the
  // grace period, `live_resume` with the bounded rescue and the mic/turn as they were; after that, a new session.
  _resume(reason) {
    if (this._destroyed) return;  // (1.10.0) instance of a doorbell that's no longer being viewed: see _destroy()
    const p = this._pauseState;
    if (!p) return;
    this._pauseState = null;
    delete PAUSED_BY_DOORBELL[this.config.device_id];
    if (this._pauseGraceTimer) { clearTimeout(this._pauseGraceTimer); this._pauseGraceTimer = null; }
    LAST_INTERACTION_MS = Date.now();
    this._resetStatusLine();
    if (p.phase === 'grace' && this.pc) {
      this._sendLivePause(false);
      if (this.videoEl) { try { const pr = this.videoEl.play(); if (pr && pr.catch) pr.catch(() => {}); } catch (err) { /* best effort */ } }
      this._setLiveState('live');
      if (this.loader) this.loader.style.opacity = '0';
      this._rescueAfterResume();
      this._armIdleWakeLockTimer();
      if (p.micOpen) this._requestTalkTurn();       // "in the same state": the turn is requested again
      return;
    }
    if (this.isConnected && this.content) this.startWebRTC(`resuming (${reason})`);
  }

  _cancelPause() {
    if (this._pauseGraceTimer) { clearTimeout(this._pauseGraceTimer); this._pauseGraceTimer = null; }
    this._pauseState = null;
    this._stopRescue();
  }

  // A new (or re-inserted) element for a doorbell paused for idleness does NOT start on its own.
  _restoreSavedPause() {
    if (!this.config || !PAUSED_BY_DOORBELL[this.config.device_id]) return false;
    if (!this._pauseState) this._pauseState = { reason: 'idle', phase: 'hung_up', micOpen: false };
    this._registerIdleActivityListeners();
    this._paintPause();
    return true;
  }

  _paintPause() {
    this._setLiveState('paused');
    if (this.loader) this.loader.style.opacity = '0';
    this._resetStatusLine();
  }

  // Contract rule 1: a live_pause/live_resume without its live_state is a message that wasn't applied.
  _sendLivePause(wantPaused) {
    this._livePauseWanted = !!wantPaused;
    if (this._livePauseAck) { clearTimeout(this._livePauseAck.timer); this._livePauseAck = null; }
    const sendAttempt = (attempt) => {
      if (!this.nativeSSE || this._livePauseWanted !== !!wantPaused) return;
      this.sendNativeSignal({ type: wantPaused ? 'live_pause' : 'live_resume' });
      const timer = setTimeout(() => {
        if (this._livePauseAck && this._livePauseAck.timer === timer && attempt < LIVE_ACK_RETRIES) sendAttempt(attempt + 1);
      }, LIVE_ACK_MS);
      this._livePauseAck = { wantPaused: !!wantPaused, timer };
    };
    sendAttempt(0);
  }

  _onLiveState(msg) {
    if (typeof msg.paused !== 'boolean') return;
    if (this._livePauseAck && this._livePauseAck.wantPaused === msg.paused) {
      clearTimeout(this._livePauseAck.timer);
      this._livePauseAck = null;
    }
  }

  // Contract rule 3: a BOUNDED rescue if no image arrives after resuming.
  _rescueAfterResume() {
    this._stopRescue();
    const pc = this.pc;
    if (!pc) return;
    const base = this._framesSeen;
    const noPicture = () => this.pc === pc && this._framesSeen === base;
    RESCUE_RESUME_MS.forEach((ms) => {
      this._rescueTimers.push(setTimeout(() => {
        if (noPicture() && !this._livePauseWanted) this._sendLivePause(false);
      }, ms));
    });
    this._rescueTimers.push(setTimeout(() => {
      if (noPicture() && !this._livePauseWanted) this._scheduleReconnect('rescue: no image 24 s after live_resume');
    }, RESCUE_NEW_SESSION_MS));
  }

  _stopRescue() {
    (this._rescueTimers || []).forEach((t) => clearTimeout(t));
    this._rescueTimers = [];
  }

  _clearIdleWakeLockTimer() {
    if (this._idleWakeLockTimer) { clearTimeout(this._idleWakeLockTimer); this._idleWakeLockTimer = null; }
  }

  _registerIdleActivityListeners() {
    if (this._onIdleActivity) return;
    this._onIdleActivity = () => {
      // Touching restores the screen: if the lock had already been released it's requested again, and if it's
      // still held only the countdown restarts. It's never requested with the page hidden -- the browser
      // would reject it there anyway, and besides it would mean requesting a screen for nobody.
      if (document.visibilityState !== 'visible') return;
      if (this._pauseState) { this._resume('tap'); return; }
      // ⚠️ IT ALWAYS REARMS, AND IT USED TO BE AN `else` (2026-09-07). The previous version said
      // `if (!this._wakeLock) this._acquireWakeLock(); else this._armIdleWakeLockTimer(true)`: which
      // meant that on a device with no wake lock -- the wallpanel-- a touch updated
      // `LAST_INTERACTION_MS` and did NOT rearm anything, leaving a trigger running that was computed with the
      // old mark. These are two independent things: rearming the countdown belongs to the interaction, requesting
      // the screen belongs to the wake lock. Requesting it remains best-effort and may not exist.
      this._armIdleWakeLockTimer(true);
      if (!this._wakeLock) this._acquireWakeLock();
    };
    this.addEventListener('pointerdown', this._onIdleActivity, { passive: true });
    document.addEventListener('keydown', this._onIdleActivity, { passive: true });
  }

  _unregisterIdleActivityListeners() {
    if (!this._onIdleActivity) return;
    this.removeEventListener('pointerdown', this._onIdleActivity);
    document.removeEventListener('keydown', this._onIdleActivity);
    this._onIdleActivity = null;
  }

  _releaseWakeLock() {
    // ⚠️ THE COUNTDOWN IS NO LONGER STOPPED HERE, AND THIS IS THE OTHER HALF OF THE 2026-09-07 FIX.
    //
    // This function is also called by _exitFullscreen() and _syncFullscreenFromBrowser(): leaving
    // fullscreen used to kill the clock while leaving the stream alive, i.e. the same hole from the other
    // end. The countdown is stopped by whoever genuinely ends the session -- the teardown on hiding,
    // the idle trigger itself, and disconnectedCallback() -- which are the three places that
    // already call _clearIdleWakeLockTimer() by hand.
    if (this._wakeLock) {
      try { this._wakeLock.release(); } catch (err) { /* best effort */ }
      this._wakeLock = null;
    }
    if (this._onVisibilityForWakeLock) {
      document.removeEventListener('visibilitychange', this._onVisibilityForWakeLock);
      this._onVisibilityForWakeLock = null;
    }
  }

  // ==============================================================================
  // Visibility of the open button. Source of truth: the `door_m` the doorbell sends on every
  // `session_info`. The safety net of learning it by failing is ONLY used while that data
  // has never arrived - i.e. against firmware that predates the field's existence.
  // ==============================================================================
  _applyDoorAvailability() {
    if (!this.unlockButton) return;
    // (1.10.0) `unlock_entity` no longer exists: opening ALWAYS goes through the doorbell (`open`), which
    // decides between a relay or a Home Assistant entity (door_m=1, with integration 0.7.6's
    // whitelist). This way the door opens the same from the card, the apps and the panel, and it's configured in a
    // single place.
    const hide = (this._doorMode !== null)
      ? this._doorMode === 2          // authoritative data from the doorbell: it always wins
      : this._noLockLegacy;           // older firmware: all that's known is that it failed
    const action = this.unlockButton.closest('.action') || this.unlockButton;
    action.style.display = hide ? 'none' : '';
    // A button that disappears while it's "armed" would leave the confirmation state stuck.
    if (hide) this._disarmDoorConfirm();
  }

  // ==============================================================================
  // OPENING THE DOOR REQUIRES CONFIRMATION (API_CONTRACT.md §1.8, 2026-07-30)
  //
  // Double-tap with visible state, not "slide to confirm". The contract rules out
  // sliding for three reasons that fully apply to this card: it's used with a MOUSE (the card
  // lives in PC dashboards), drag gestures are a known problem for TalkBack/
  // VoiceOver/switch control, and on a wall tablet in portrait, horizontal sliding
  // competes with system gestures. The precedent is the Aqara lock in Home Assistant
  // itself, which does exactly this.
  //
  // And it's an INLINE message, not a modal dialog: a modal that has to be dismissed with someone
  // waiting at the door also covers the video, which is exactly what the user is looking at to
  // decide whether to open.
  //
  // The three rules without which this gives a feeling of safety without actually providing it:
  //  1. It EXPIRES after ~3s. Without this an accidental tap leaves the door ARMED and the next
  //     one -equally accidental- opens it: worse than having nothing at all.
  //  2. A FAST double tap doesn't count (minimum ~300ms). A phone in a pocket, a child, or a finger
  //     that bounces produce exactly a double tap.
  //  3. After opening it goes back to the normal state, never to "confirming".
  // ==============================================================================
  _onDoorPress() {
    const now = Date.now();
    if (!this._doorArmedAt) { this._armDoorConfirm(); return; }
    // Rule 2: below the threshold it doesn't count as confirmation, NOR does it disarm - a bounce must not
    // force the user to start over, it just must not open.
    if (now - this._doorArmedAt < 300) return;
    this._disarmDoorConfirm();
    this.triggerNativeOpen();
  }

  _armDoorConfirm() {
    this._doorArmedAt = Date.now();
    if (this.unlockButton) this.unlockButton.classList.add('confirming');
    if (this.unlockIcon) this.unlockIcon.setAttribute('icon', 'mdi:help-circle-outline');
    if (this.unlockLabel) {
      this.unlockLabel.textContent = getLocalText(this._hass, 'lbl_door_confirm');
      this.unlockLabel.classList.add('on-amber');
    }
    this._flashStatusLine('door_confirm', 3000);
    if (this._doorArmTimer) clearTimeout(this._doorArmTimer);
    this._doorArmTimer = setTimeout(() => this._disarmDoorConfirm(), 3000);
  }

  _disarmDoorConfirm() {
    if (this._doorArmTimer) { clearTimeout(this._doorArmTimer); this._doorArmTimer = null; }
    if (!this._doorArmedAt) return;
    this._doorArmedAt = 0;
    if (this.unlockButton) this.unlockButton.classList.remove('confirming');
    // The idle icon/label is only returned if the door isn't open right now: if
    // this gets called right before opening, triggerNativeOpen() is in charge.
    const isOpen = this.unlockButton && this.unlockButton.classList.contains('active-unlock');
    if (!isOpen) {
      if (this.unlockIcon) this.unlockIcon.setAttribute('icon', 'mdi:lock-open-variant');
      if (this.unlockLabel) this.unlockLabel.classList.remove('on-amber');
      this._setDoorLabel(false);
    }
  }

  // ==============================================================================
  // CLIENT SOUND (API_CONTRACT.md §1.10, 2026-07-30)
  //
  // What this rule is NOT, and confusing it would leave the user deaf right when someone's at the
  // door: it's NOT "silence until you talk". Listening and talking are independent axes - the
  // visitor is heard and THEN you decide whether to answer. That's why the speaker has its own control,
  // separate from the mic button.
  //
  // It also doesn't affect recordings: an event is always recorded with sound. What gets muted is
  // the live playback for a client who's only watching.
  //
  // Real browser limitation that forces this design: the <video> is born `muted` out of
  // NECESSITY (autoplay policy - with sound, play() would be rejected and there wouldn't even be an image),
  // so unmuting always needs a user activation on the page. When the attempt
  // fails, it doesn't pretend it worked: it goes back to muted and says the speaker needs to be tapped.
  // ==============================================================================
  _setAudioOn(on, reason) {
    const wantOn = !!on;
    this._audioOn = wantOn;
    if (this.videoEl) {
      this.videoEl.muted = !wantOn;
      if (wantOn && typeof this.videoEl.play === 'function') {
        // Unmuting with no user activation can make the browser PAUSE the element instead
        // of throwing an error - hence the play() and its catch.
        const p = this.videoEl.play();
        if (p && typeof p.catch === 'function') {
          p.catch(() => {
            this.videoEl.muted = true;
            this._audioOn = false;
            this._paintAudioState();
            this._flashStatusLine('snd_blocked', 5000);
            console.warn(`[ig-doorbell-card] the browser did not allow turning on the sound (reason="${reason}") - the user needs to tap the speaker control`);
          });
        }
      }
    }
    this._paintAudioState();
  }

  _paintAudioState() {
    if (this.volIcon) this.volIcon.setAttribute('icon', this._audioOn ? 'mdi:volume-high' : 'mdi:volume-off');
    if (this.sndBtn) {
      this.sndBtn.classList.toggle('on', !!this._audioOn);
      this.sndBtn.setAttribute('title', getLocalText(this._hass, this._audioOn ? 'snd_on' : 'snd_off'));
      this.sndBtn.setAttribute('aria-pressed', this._audioOn ? 'true' : 'false');
    }
    if (this.sndLabel) this.sndLabel.textContent = getLocalText(this._hass, this._audioOn ? 'snd_on' : 'snd_off');
  }

  // The doorbell ring is the only reason the sound turns on BY ITSELF (§1.10): it's the moment the
  // device exists for. The signal doesn't travel over WebRTC signaling, so it's read from a
  // Home Assistant entity the user configures (`ring_entity`).
  //
  // ⚠️ WHERE THAT ENTITY COMES FROM CHANGED ON 2026-08-24, and this comment used to say the old way: the
  // firmware published it over MQTT (`videoportero/timbre`). MQTT was retired (§4) and now the
  // Home Assistant integration creates it, as **an `event`-type entity** -- the events one, which carries
  // everything the doorbell reports. Nothing changes here, because the `event` branch further below already
  // existed; what changes is that THAT one has to be configured, and that an older ring
  // `binary_sensor` will be left without updates.
  //
  // Both shapes that entity can have are supported: a `binary_sensor` (transition to 'on')
  // and an `event` (whose `state` is the timestamp of the last event, not 'on'/'off' - treating it
  // as binary would never fire).
  _updateRingState() {
    // By default, the integration's events entity (get_connection_info provides it): this way a
    // ring wakes up a paused card with nothing configured.
    const entityId = this._entityFor('ring');
    if (!entityId || !this._hass) { this._ringMarker = null; return; }
    const stateObj = this._hass.states[entityId];
    if (!stateObj) { this._ringMarker = null; return; }
    const isEvent = entityId.split('.')[0] === 'event';
    const marker = isEvent ? String(stateObj.state) : (stateObj.state === 'on' ? 'on' : 'off');
    const prevMarker = this._ringMarker;
    this._ringMarker = marker;
    // First read: does NOT fire. On opening the dashboard, a binary_sensor that's been 'on' for a while
    // (or an event with an old timestamp) isn't a call happening right now.
    // ⚠️ EXCEPT to wake up a pause: the ring that brings the panel to the front (a typical
    // automation) can CREATE this card, and for it that ring is its "first read". If it's
    // from less than RECENT_RING_MS ago, it counts.
    if (prevMarker === null || prevMarker === undefined) {
      if (this._pauseState && isEvent && stateObj.attributes && stateObj.attributes.event_type === 'ring'
        && Date.now() - Date.parse(marker) < RECENT_RING_MS && document.visibilityState === 'visible') this._resume('recent ring');
      return;
    }
    // ⚠️ On the events entity only `ring` counts: the same entity carries packages, visitors,
    // modes... (§1.16), and treating those as a ring would turn on the sound for a package.
    const hasRung = isEvent
      ? (marker !== prevMarker && marker !== 'unknown' && marker !== 'unavailable'
        && (!stateObj.attributes || !stateObj.attributes.event_type || stateObj.attributes.event_type === 'ring'))
      : (marker === 'on' && prevMarker !== 'on');
    if (!hasRung) return;
    // A new ring wakes up a card paused for idleness, by itself.
    if (this._pauseState && document.visibilityState === 'visible') this._resume('ring');
    if (this._audioOn) return; // it was already audible: nothing to announce
    this._setAudioOn(true, 'ring');
    if (this._audioOn) this._flashStatusLine('snd_ring', 6000);
  }

  // ==============================================================================
  // IMAGE ROTATION (API_CONTRACT.md §1.9, 2026-07-30)
  //
  // `rot` is DEGREES CLOCKWISE FOR THE CLIENT TO APPLY, and CSS `rotate()` also rotates
  // clockwise: the mapping is direct, no conversion needed.
  //
  // With 90/270 the width and height swap, and that can't be expressed in pure CSS without
  // knowing the container's size - hence the JS calculation with a ResizeObserver. The usual
  // `object-fit: contain` still does the letterboxing inside the already-rotated box.
  //
  // What is NOT done, and this matters: cropping to fill. Zooming to cover the width
  // throws away the top and bottom, which is exactly what was gained by rotating the sensor.
  // That would undo the whole point of the change.
  // ==============================================================================
  _rotStorageKey() {
    return `ig-doorbell-rot-${this.config && this.config.device_id ? this.config.device_id : 'no-id'}`;
  }

  _recallRotation() {
    try {
      const savedValue = localStorage.getItem(this._rotStorageKey());
      const n = savedValue === null ? null : parseInt(savedValue, 10);
      if (n === 0 || n === 90 || n === 180 || n === 270) return n;
    } catch (err) { /* localStorage might be blocked; that's not a reason not to work */ }
    return 90; // first time and only the first time: the product's mounting is portrait
  }

  _rememberRotation(rot) {
    try { localStorage.setItem(this._rotStorageKey(), String(rot)); } catch (err) { /* idem */ }
  }

  _applyRotation(rot) {
    if (rot !== 0 && rot !== 90 && rot !== 180 && rot !== 270) {
      // A weird value gets ignored instead of rendered: rendering it tilted with nothing explaining it is
      // worse than not rotating at all. Same criterion as the firmware, which doesn't store it either (§1.9).
      console.warn(`[ig-doorbell-card] "rot" with an unsupported value (${rot}) - ignored, keeping ${this._rot}°`);
      return;
    }
    const rotChanged = (rot !== this._rot) || !this._rotConfirmed;
    this._rot = rot;
    this._rotConfirmed = true;
    this._rememberRotation(rot);
    if (!rotChanged) return;
    if (this.feedWrap) this.feedWrap.setAttribute('data-rot', String(rot));
    // WITHOUT animation, on purpose (§1.9): an animated transition turns a one-time error
    // into an effect that looks intentional and repeats on every startup.
    this._applyFeedAspect();
    this._layoutRotation();
  }

  // Shape of the video frame. With the image in portrait the card stops being 16:9 and becomes 9:16 -
  // which is what makes the video look BIG on a phone held vertically, the normal case for
  // answering a ring. The height cap avoids the absurdity of a 2000px card on a wide panel:
  // there the video gets centered with space left over on the sides, which is the case §1.9 solves with the
  // side rail (see _layoutRotation).
  _applyFeedAspect() {
    if (!this.feedWrap) return;
    // The SAME bug as the rail's (see _layoutRotation, 2026-09-08) and the same fix: the
    // frame's shape has to be decided by the ALREADY-oriented CONTENT, not by whether there's software
    // rotation. With the sensor delivering the image already in portrait (_rot=0, Iñaki's real
    // doorbell), the old `_rot===90||270` version said "landscape" and the frame stayed 16:9 -
    // a short widescreen box for a video that's actually portrait, which on top of that manufactures an
    // artificial side margin and also confuses the rail (measured: on a vertical phone + vertical
    // video with no rotation, that malformed frame made the rail trigger in the case it
    // EXPLICITLY must not trigger). Once metadata has loaded, the real content is used;
    // without it (startup, before 'loadedmetadata') `_rot` is used as the best guess and this
    // function gets called again as soon as it arrives (see render()).
    // 1.9.7: the height no longer comes from a fixed ratio (9:16 capped at 72vh, or the YAML's
    // bare `height`) but from _fitToSpace(), which measures the real available space. See there for why.
    this._fitToSpace();
  }

  // ==============================================================================================
  // THE CARD FITS ITSELF INTO WHATEVER SPACE IT HAS (1.9.7, Iñaki 2026-09-25: «the card should adjust
  // itself to the available space»; and deliberately ruling out the user manually lowering the
  // `height` of their panel).
  //
  // What there was until 1.9.6, measured with Playwright against a real Home Assistant (the doorbell's
  // `panel` view, 393x852 like Iñaki's iPhone):
  //   - the video frame took the YAML's `height` AS-IS (650px) - with the real video at
  //     1080x1200 (almost square) in a 373px-wide space, the image occupies 414px and the other ~240px were
  //     black bars, the TOP one is the «dark gap above the video» from the screenshot;
  //   - and Recordings NEVER showed up for a different reason, not the height: see .bottom-row in the sheet.
  //   - HA's wrapper does NOT crop anything: `hui-panel-view` measures exactly the viewport minus
  //     the HA bar (796px out of 852) with overflow visible. What didn't fit was the card itself.
  //
  // Now: the available height gets MEASURED (visible viewport minus whatever is above the card, which
  // in the panel view is the HA bar), what the controls take up is subtracted from it, and the video
  // keeps whatever's left, preserving its ratio (bars on the sides if needed, never
  // controls pushed out). The YAML's `height` becomes a CAP, not a fixed height.
  //
  // THREE layouts since 1.11.0 (Iñaki approved the proposals of the 1.10.0 layout analysis), chosen by
  // the card's OWN measured space - never by configuration (the card has none) and never by device:
  //   - STACK (portrait phone, like the iOS app): video on top, chips below, buttons below
  //     that (outside the image), Recordings at the bottom.
  //   - OVERLAY (landscape, wide but short): chips on top, buttons over the bottom of the video,
  //     Recordings below. When the height is short (phone in landscape) Recordings/Quick replies
  //     move into the header as icon buttons (`ig-short`), which gives that height to the video.
  //   - SIDE COLUMN (`ig-side`, wide panels and tablets): the video takes the full height and a
  //     SIDE_COL_W column hugs the image's right edge with EVERYTHING else: doorbell picker, mode
  //     chip, REC, bell; sound, mic, door; Recordings, Quick replies. Never below SIDE_MIN_H: under
  //     that the column can't hold its targets (phone in landscape pushed the mic off-screen).
  // Exactly one is active at a time (`_layout`). Two at once is what produced the 1.9.8 bug of the
  // mic straddling the video's bottom edge (rail + stack). The side rail of §1.9 still exists, but
  // only in FULLSCREEN (see _layoutRotation): outside fullscreen its job is done by the side column.
  // How one is picked: _planLayout() computes the picture each layout would give and keeps the
  // biggest, with a penalty for OVERLAY (its buttons cover part of the picture) and a small bonus
  // for the current one (hysteresis, so a size on the boundary doesn't flip-flop).
  // ==============================================================================================
  static get STACK_CONTROLS_H() { return 128; }  // button row in stack: mic 96 + label + breathing room
  static get MIN_FEED_H() { return 180; }
  // (1.11.0) Floor for the last-resort layout (nothing else fits: a narrow card on a phone in landscape,
  // where the header may even wrap to two lines). The buttons over the picture need ~150 px (mic 80 +
  // label + status line); holding 180 there made the page scroll by 24 px in a Sections view.
  static get MIN_FALLBACK_FEED_H() { return 150; }
  // (1.11.0) Side column. 144 and not a round 140: in the compact column the header row holds three
  // 44 px touch targets (mode, REC, bell) with two 6 px gaps = 144. At 140 they came out at 42.7 px.
  static get SIDE_COL_W() { return 144; }
  // Below this height the column can't hold its targets without scrolling or clipping (compact
  // column measured at ~336 px with 44 px targets). Iñaki: "no side column/rail under 350 px".
  static get SIDE_MIN_H() { return 350; }
  // From this height up the column shows labels and the bigger buttons (measured ~551 px of content).
  static get SIDE_FULL_H() { return 600; }
  // The picture must keep at least this width next to the column; narrower, the column isn't worth it.
  static get SIDE_MIN_IMG_W() { return 160; }
  // OVERLAY puts the buttons over the image, so it can't be narrower than the button row plus the HUD
  // (same 520 px threshold the stack decision used since 1.9.7).
  static get OVERLAY_MIN_W() { return 520; }
  // OVERLAY below this height moves Recordings/Quick replies into the header (`ig-short`).
  static get SHORT_H() { return 480; }
  // A covered picture is worth less than a free one: OVERLAY's area counts at 85 % (the same 15 % the
  // 1.9.7 stack decision used).
  static get OVERLAY_PENALTY() { return 0.85; }
  // Hysteresis: the current layout's score gets +5 %.
  static get LAYOUT_STICKY() { return 1.05; }

  _viewHost() {
    // The Lovelace view's container (hui-panel-view, hui-masonry-view...), also walking up
    // through the shadow roots. Only its top edge is used: that's where the HA bar ends.
    let el = this;
    for (let i = 0; i < 25 && el; i++) {
      const tag = el.tagName ? el.tagName.toLowerCase() : '';
      if (tag === 'hui-panel-view' || tag === 'hui-masonry-view' || tag === 'hui-sections-view' || tag === 'hui-view') return el;
      el = el.parentElement || (el.getRootNode && el.getRootNode().host) || null;
    }
    return null;
  }

  _availableHeight() {
    const vv = window.visualViewport;
    const vh = vv && vv.height ? vv.height : window.innerHeight;
    const sy = window.scrollY || 0;
    const cardTop = this.getBoundingClientRect().top + sy;
    const view = this._viewHost();
    const viewTop = view ? view.getBoundingClientRect().top + sy : 0;
    const panel = !!(view && view.tagName.toLowerCase() === 'hui-panel-view');
    // What's above the card at the top of the page: the HA bar and the view's margin. A
    // card further down in a column doesn't shrink because of what's above it (you reach
    // it by scrolling); it fits to a screen, not to whatever's left of the first one.
    const reservedTop = Math.max(0, Math.min(cardTop, viewTop + 24));
    // (1.11.0) And what Home Assistant puts UNDER the card (the section's and the view's bottom
    // padding). Until 1.10.0 this was a flat 8 px and the page scrolled by 2-20 px in most views
    // (measured in the 1.10.0 layout analysis: Sections 19, Masonry 3, Panel 2).
    return Math.max(0, vh - reservedTop - this._bottomReserve(panel));
  }

  // Sum of the bottom padding/border/margin of every ancestor up to the document (crossing shadow
  // roots): the space the page adds under the card when the card is the last thing in its column,
  // which is the case this sizing is for (a card further up a column is reached by scrolling
  // anyway). Capped, so a strange theme can't collapse the card.
  _bottomReserve(panel) {
    let sum = 0;
    let el = this.parentElement || (this.getRootNode && this.getRootNode().host) || null;
    for (let i = 0; i < 40 && el && el !== document.documentElement; i++) {
      const cs = getComputedStyle(el);
      sum += (parseFloat(cs.paddingBottom) || 0) + (parseFloat(cs.borderBottomWidth) || 0) + Math.max(0, parseFloat(cs.marginBottom) || 0);
      el = el.parentElement || (el.getRootNode && el.getRootNode().host) || null;
    }
    return Math.min(64, Math.max(panel ? 0 : 4, Math.ceil(sum)));
  }

  // (1.10.0) No cap: the YAML's `height` option (which since 1.9.7 was only a cap) was removed
  // along with the rest of the configuration. The height comes from the measured space (_availableHeight).
  _feedCap() {
    return Infinity;
  }

  _recallAspect() {
    try {
      const v = parseFloat(localStorage.getItem(`ig-doorbell-aspect-${this.config && this.config.device_id || 'no-id'}`));
      if (v > 0.2 && v < 5) return v;
    } catch (err) { /* no storage: assumed */ }
    return (this._rot === 90 || this._rot === 270) ? 9 / 16 : 16 / 9;
  }

  _rememberAspect(a) {
    if (Math.abs((this._lastAspectSaved || 0) - a) < 0.001) return;
    this._lastAspectSaved = a;
    try { localStorage.setItem(`ig-doorbell-aspect-${this.config && this.config.device_id || 'no-id'}`, String(a)); } catch (err) { /* idem */ }
  }

  _fitToSpace() {
    if (!this.feedWrap || !this.content || typeof getComputedStyle !== 'function') return;   // no layout (test benches in a VM)
    if (this._fsActive) {
      // Fullscreen has its own sheet (.ig-fs): buttons always over the video (or in the §1.9 rail).
      this._applyLayout({ layout: 'overlay', short: false, feedH: null, imgW: null });
      return;
    }
    const cs = getComputedStyle(this.content);
    const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const gap = parseFloat(cs.rowGap) || 10;
    // (1.11.0) The CONTAINER's width, not the frame's: in the side column the frame is sized to the image.
    const width = Math.max(0, this.content.clientWidth - padX);
    if (!width) return;
    const c = this._contentSize();
    let aspect;
    if (c.w > 0 && c.h > 0) { aspect = c.w / c.h; this._rememberAspect(aspect); } else aspect = this._recallAspect();

    const avail = this._availableHeight();
    const plan = this._planLayout({ width, aspect, avail, padY, gap });
    this._applyLayout(plan);

    // ---- Correction pass (1.11.0): MEASURE what the layout really took and give the difference to
    // the video. The chrome in _planLayout is an estimate (the header's height changes with the
    // pointer type, the language, whether REC/mode exist...); until 1.10.0 the estimate was the
    // final word and the page scrolled by a few px in most views. One synchronous re-measure, no
    // loop: the ResizeObserver that fires afterwards recomputes the same numbers.
    const real = this.getBoundingClientRect().height;
    const delta = avail - real;
    if (real > 0 && Math.abs(delta) > 0.5) {
      let feedH = plan.feedH + delta;
      if (plan.layout === 'side') {
        feedH = Math.min(feedH, (width - IgDoorbellView.SIDE_COL_W - gap) / aspect);
      } else {
        feedH = Math.min(feedH, width / aspect, this._feedCap());
      }
      feedH = Math.round(Math.max(Math.min(plan.minH || IgDoorbellView.MIN_FEED_H, width / aspect), feedH));
      if (Math.abs(feedH - plan.feedH) >= 1) {
        plan.feedH = feedH;
        if (plan.layout === 'side') plan.imgW = Math.round(feedH * aspect);
        this._applyLayout(plan);
      }
    }
  }

  // Picks ONE of the three layouts (see the block comment above STACK_CONTROLS_H) from the space
  // alone. Arithmetic on estimates; _fitToSpace() then corrects the height with a real measurement.
  _planLayout({ width, aspect, avail, padY, gap }) {
    const K = IgDoorbellView;
    const coarse = this._coarsePointer();
    const natural = width / aspect;
    const cap = this._feedCap();
    // Header and Recordings row: measured where they normally live, estimated while they are
    // somewhere else (inside the column, or Recordings inside the header).
    const topH = (this.topRow && this.topRow.parentElement === this.content && this.topRow.offsetHeight) || (coarse ? 44 : 34);
    const hasBottom = !!this.recordingsAction && this.recordingsAction.style.display !== 'none';
    const bottomH = hasBottom ? ((this.recordingsAction.parentElement === this.content && this.recordingsAction.offsetHeight) || 52) : 0;
    const area = (h, w) => { const iw = Math.min(w, h * aspect); return iw * (iw / aspect); };
    // The smallest frame worth having: MIN_FEED_H, or less when the picture itself is smaller at this
    // width (a landscape stream in a 300 px column is 169 px tall and that's not a reason to reject STACK).
    const minH = Math.min(K.MIN_FEED_H, natural);

    const cands = [];
    // STACK: video, header, buttons, Recordings - all outside the image.
    {
      const feedH = Math.min(natural, avail - padY - topH - gap - K.STACK_CONTROLS_H - gap - (bottomH ? bottomH + gap : 0), cap);
      if (feedH >= minH) cands.push({ layout: 'stack', short: false, feedH, imgW: null, score: area(feedH, width) });
    }
    // OVERLAY: header, video with the buttons over it, Recordings (inside the header when short).
    if (width >= K.OVERLAY_MIN_W) {
      const short = hasBottom && avail < K.SHORT_H;
      const feedH = Math.min(natural, avail - padY - topH - gap - (bottomH && !short ? bottomH + gap : 0), cap);
      if (feedH >= minH) cands.push({ layout: 'overlay', short, feedH, imgW: null, score: area(feedH, width) * K.OVERLAY_PENALTY });
    }
    // SIDE COLUMN: the image at full height and the column hugging it. The column is as tall as the
    // image, so the IMAGE must be at least SIDE_MIN_H tall (a wide stream in a narrow card isn't).
    {
      const imgH = Math.min(avail - padY, (width - K.SIDE_COL_W - gap) / aspect, cap);
      const imgW = imgH * aspect;
      if (imgH >= K.SIDE_MIN_H && imgW >= K.SIDE_MIN_IMG_W) cands.push({ layout: 'side', short: false, feedH: imgH, imgW, score: imgW * imgH });
    }
    for (const p of cands) if (p.layout === this._layout) p.score *= K.LAYOUT_STICKY;
    cands.sort((a, b) => b.score - a.score);
    // Nothing fits (a card squeezed into a tiny slot): OVERLAY at the minimum height is the one that
    // still keeps every button on screen, over the picture.
    const best = cands[0] || { layout: 'overlay', short: hasBottom, imgW: null, fallback: true,
      feedH: avail - padY - topH - gap, minH: Math.min(K.MIN_FALLBACK_FEED_H, natural) };
    if (!best.minH) best.minH = minH;
    best.feedH = Math.round(Math.max(best.minH, Math.min(best.feedH, natural, cap)));
    if (best.layout === 'side') best.imgW = Math.round(best.feedH * aspect);
    return best;
  }

  _coarsePointer() {
    try { return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); } catch (err) { return false; }
  }

  // Applies a plan: exactly one layout class, the groups where that layout wants them, the frame's size.
  _applyLayout(plan) {
    const L = plan.layout;
    const c = this.content;
    this._layout = L;
    c.classList.toggle('ig-stack', L === 'stack');
    c.classList.toggle('ig-side', L === 'side');
    c.classList.toggle('ig-short', L === 'overlay' && !!plan.short);
    c.classList.toggle('ig-side-compact', L === 'side' && plan.feedH < IgDoorbellView.SIDE_FULL_H);
    this._placeControls(L, !!plan.short);
    const fw = this.feedWrap;
    if (plan.feedH === null) {
      // Fullscreen: the .ig-fs sheet sizes the frame. No inline width may survive from the column
      // (the .ig-fs width:100% has no !important and an inline width would beat it).
      if (fw.style.width) fw.style.width = '';
      if (this.sideCol && this.sideCol.style.height) this.sideCol.style.height = '';
      return;
    }
    if (Math.abs((parseFloat(fw.style.height) || 0) - plan.feedH) > 0.5) fw.style.height = `${plan.feedH}px`;
    const w = L === 'side' ? `${plan.imgW}px` : '';
    if (fw.style.width !== w) fw.style.width = w;
    if (this.sideCol) {
      const h = L === 'side' ? `${plan.feedH}px` : '';
      if (this.sideCol.style.height !== h) this.sideCol.style.height = h;
    }
    if (fw.style.aspectRatio !== 'auto') fw.style.aspectRatio = 'auto';
    if (fw.style.maxHeight) fw.style.maxHeight = '';
  }

  // Moves the three groups (header, buttons, Recordings row) to where the layout wants them.
  // MOVING, never cloning: every listener and every reference (this.micButton...) stays valid.
  _placeControls(layout, short) {
    const c = this.content;
    const top = this.topRow; const act = this.actionsRow; const rec = this.recordingsAction;
    if (!c || !top || !act || !rec || !this.stackControls || !this.feedWrap) return;
    if (layout === 'side' && this.sideCol) {
      const k = this.sideCol.children;
      if (k[0] !== top || k[1] !== act || k[2] !== rec) this.sideCol.append(top, act, rec);
      return;
    }
    if (top.parentElement !== c || top.nextElementSibling !== this.feedWrap) c.insertBefore(top, this.feedWrap);
    const dest = layout === 'stack' ? this.stackControls : this.feedWrap;
    if (act.parentElement !== dest) dest.appendChild(act);
    const topRight = top.querySelector('.top-right');
    if (short && topRight) {
      if (topRight.firstElementChild !== rec) topRight.insertBefore(rec, topRight.firstElementChild);
    } else if (rec.parentElement !== c || rec.nextElementSibling !== this._evPanel) {
      c.insertBefore(rec, this._evPanel || null);
    }
  }

  _scheduleFit() {
    if (this._fitRaf) return;
    const run = () => { this._fitRaf = null; this._fitToSpace(); this._layoutRotation(); };
    this._fitRaf = (typeof requestAnimationFrame === 'function') ? requestAnimationFrame(run) : setTimeout(run, 16);
  }

  _registerFitObservers() {
    if (this._fitObserving || !this.content || typeof window === 'undefined' || !window.addEventListener) return;
    this._fitObserving = true;
    this._onFitResize = () => this._scheduleFit();
    window.addEventListener('resize', this._onFitResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', this._onFitResize);
    if (typeof ResizeObserver === 'function') {
      // The element itself (the column's width changes, REC/Recordings appears...) and the
      // view's container (the tablet rotates, HA's side bar opens).
      this._fitRO = new ResizeObserver(() => this._scheduleFit());
      this._fitRO.observe(this);
      const view = this._viewHost();
      if (view) this._fitRO.observe(view);
    }
    this._scheduleFit();
  }

  _unregisterFitObservers() {
    if (!this._fitObserving) return;
    this._fitObserving = false;
    window.removeEventListener('resize', this._onFitResize);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', this._onFitResize);
    if (this._fitRO) { this._fitRO.disconnect(); this._fitRO = null; }
  }

  // ==============================================================================================
  // NOTIFICATION BELL (1.9.7). WHERE THE DATA COMES FROM, and why from there:
  //  - The doorbell has NO event-history route: the apps collect them from the relay's
  //    queue (§3.6.3), which belongs to the VPS - and this card doesn't talk to the VPS (principle 1 and Phase 0).
  //  - What DOES arrive over the LAN is every event, in the moment, via the doorbell's local webhook to
  //    the integration (webhook.py, `local_only`), which publishes it on its `event` entity (event.py)
  //    with the whole envelope as attributes. Home Assistant's recorder stores those changes.
  //  - The card requests them with Home Assistant's NATIVE history command
  //    (`history/history_during_period`) over HA's own already-authenticated WebSocket, for the
  //    entity the integration gives it in `get_connection_info.events_entity`. No credential
  //    from the doorbell ever passes through the browser, and it works with no internet.
  //  - How long they're kept is decided by HA's recorder (`purge_keep_days`, 10 days by default),
  //    not this card. Events generated by the RELAY (call answered/missed, no connection) don't
  //    go through the webhook and don't show up here.
  // ==============================================================================================
  _eventsEntity() {
    return (this._connInfo && this._connInfo.events_entity) || this._autoEntity('events') || null;
  }

  _bellSeenKey() { return `ig-doorbell-bell-seen-${this.config && this.config.device_id || 'no-id'}`; }
  _bellSeen() {
    try { const v = parseInt(localStorage.getItem(this._bellSeenKey()), 10); return Number.isFinite(v) ? v : 0; } catch (err) { return 0; }
  }
  _setBellSeen(ms) { try { localStorage.setItem(this._bellSeenKey(), String(ms)); } catch (err) { /* idem */ } }

  _isNotice(ev) {
    const k = IG_EVENT_KINDS[ev];
    return k ? k.notice : true;   // unknown: it's shown, just like in the apps
  }

  _updateBell() {
    if (!this._bellBtn) return;
    const ent = this._eventsEntity();
    const st = ent && this._hass ? this._hass.states[ent] : null;
    this._bellBtn.style.display = st ? '' : 'none';
    if (!st) return;
    if (this._bellLastState !== st.state) {
      const firstTime = this._bellLastState === undefined;
      this._bellLastState = st.state;
      if (firstTime) {
        this._checkUnread();
      } else {
        const ev = st.attributes && st.attributes.event_type;
        const ts = Date.parse(st.state) || Date.now();
        if (ev && this._isNotice(ev) && ts > this._bellSeen()) this._bellUnread = true;
        if (this._evOpen) this._loadEvents();
      }
    }
    this._paintBell();
  }

  _paintBell() {
    if (!this._bellBtn) return;
    this._bellBtn.classList.toggle('unread', !!this._bellUnread);
    this._bellBtn.setAttribute('title', igEvText(this._hass, this._bellUnread ? 'bell_new' : 'bell'));
    this._bellBtn.setAttribute('aria-label', igEvText(this._hass, this._bellUnread ? 'bell_new' : 'bell'));
  }

  async _fetchEvents(startMs, endMs) {
    const ent = this._eventsEntity();
    if (!ent) throw new Error('no_entity');
    const res = await this._hass.connection.sendMessagePromise({
      type: 'history/history_during_period',
      start_time: new Date(startMs).toISOString(),
      end_time: new Date(endMs).toISOString(),
      entity_ids: [ent],
      include_start_time_state: false,
      significant_changes_only: false,
      minimal_response: false,
      no_attributes: false,
    });
    const rows = (res && res[ent]) || [];
    const out = [];
    for (const x of rows) {
      const st = x.s !== undefined ? x.s : x.state;
      const a = x.a || x.attributes || {};
      const ev = a.event_type;
      if (!ev || st === 'unavailable' || st === 'unknown') continue;
      let ts = (typeof a.ts === 'number' && a.ts > 1e9) ? a.ts * 1000 : Date.parse(st);
      if (!Number.isFinite(ts)) ts = (x.lu || x.lc || 0) * 1000;
      if (ts < startMs - 60000 || ts > endMs + 60000) continue;
      out.push({ ev, ts, a });
    }
    out.sort((p, q) => q.ts - p.ts);
    return out;
  }

  async _checkUnread() {
    if (this._bellChecking || !this._hass || !this._hass.connection) return;
    this._bellChecking = true;
    try {
      const now = Date.now();
      const items = await this._fetchEvents(now - 7 * 86400000, now);
      const seen = this._bellSeen();
      this._bellUnread = items.some((e) => this._isNotice(e.ev) && e.ts > seen);
      this._paintBell();
    } catch (err) {
      console.warn('[ig-doorbell-card] bell: could not read the events history', err);
    } finally {
      this._bellChecking = false;
    }
  }

  _evLang() { return (this._hass && this._hass.language) || navigator.language || 'en'; }

  _evFirstDayOfWeek() {
    // Like the apps: the first day of the week comes from the language's calendar, not from subtracting 7 days.
    try {
      const loc = new Intl.Locale(this._evLang());
      const info = (typeof loc.getWeekInfo === 'function') ? loc.getWeekInfo() : loc.weekInfo;
      if (info && info.firstDay) return info.firstDay % 7;   // 1=Monday ... 7=Sunday -> 0=Sunday
    } catch (err) { /* browser without weekInfo */ }
    return 1;
  }

  _evBounds() {
    const now = new Date();
    const r = this._evRange || 'day';
    if (r === 'lastHour') return [now.getTime() - 3600000, now.getTime()];
    if (r === 'last6Hours') return [now.getTime() - 6 * 3600000, now.getTime()];
    if (r === 'day') {
      // By components, not by subtracting 24h: the day of a DST change doesn't last 24h (same as the apps).
      const d0 = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (this._evOffset || 0));
      const d1 = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() + 1);
      return [d0.getTime(), Math.min(d1.getTime(), now.getTime())];
    }
    const first = this._evFirstDayOfWeek();
    const back = (now.getDay() - first + 7) % 7;
    const w0 = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back - 7 * (this._evOffset || 0));
    const w1 = new Date(w0.getFullYear(), w0.getMonth(), w0.getDate() + 7);
    return [w0.getTime(), Math.min(w1.getTime(), now.getTime())];
  }

  _evPeriodLabel() {
    const off = this._evOffset || 0;
    const lang = this._evLang();
    if (this._evRange === 'day') {
      if (off === 0) return igEvText(this._hass, 'today');
      if (off === 1) return igEvText(this._hass, 'yesterday');
      const [a] = this._evBounds();
      return new Intl.DateTimeFormat(lang, { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(a));
    }
    if (this._evRange === 'week') {
      if (off === 0) return igEvText(this._hass, 'this_week');
      if (off === 1) return igEvText(this._hass, 'last_week');
      const [a] = this._evBounds();
      const f = new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'short' });
      return `${f.format(new Date(a))} – ${f.format(new Date(a + 6 * 86400000))}`;
    }
    return '';
  }

  _openEvents() {
    if (!this._evPanel) return;
    this._evOpen = true;
    if (!this._evRange) { this._evRange = 'day'; this._evOffset = 0; this._evGroup = null; }
    this._evPrevSeen = this._bellSeen();
    this._setBellSeen(Date.now());
    this._bellUnread = false;
    this._paintBell();
    this._evPanel.style.display = 'flex';
    this._evItems = null;
    this._evError = null;
    this._renderEvents();
    this._loadEvents();
  }

  _closeEvents() {
    this._evOpen = false;
    if (this._evPanel) this._evPanel.style.display = 'none';
  }

  async _loadEvents() {
    const gen = (this._evGen = (this._evGen || 0) + 1);
    const [a, b] = this._evBounds();
    try {
      const items = await this._fetchEvents(a, b);
      if (gen !== this._evGen) return;
      this._evItems = items.filter((e) => this._isNotice(e.ev));
      this._evError = null;
    } catch (err) {
      if (gen !== this._evGen) return;
      this._evError = (err && err.message === 'no_entity') ? 'no_entity' : 'load_err';
      console.warn('[ig-doorbell-card] events history', err);
    }
    if (this._evOpen) this._renderEvents();
  }

  _evPresent(e) {
    const T = (k, v) => igEvText(this._hass, k, v);
    const esc = (v) => String(v).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
    const kind = IG_EVENT_KINDS[e.ev];
    const who = ['by', 'label', 'por'].map((k) => e.a[k]).find((v) => typeof v === 'string' && v.trim());
    let title = kind ? T(e.ev) : T('unknown');
    let detail = kind ? (who ? T('by', { w: esc(who.trim()) }) : '') : esc(e.ev);
    if (e.ev === 'mode_changed') {
      const m = parseInt(e.a.mode !== undefined ? e.a.mode : e.a.modo, 10);
      if (m >= 0 && m <= 3) title = T('mode_to', { m: T(`m${m}`) });
    }
    return { title, detail, icon: kind ? kind.icon : 'mdi:information-outline', c: kind ? kind.c : 'muted', g: kind ? kind.g : 'status' };
  }

  _renderEvents() {
    const p = this._evPanel;
    if (!p) return;
    const T = (k, v) => igEvText(this._hass, k, v);
    const lang = this._evLang();
    const items = this._evItems || [];
    const present = IG_EVENT_GROUPS.filter((g) => items.some((e) => this._evPresent(e).g === g));
    if (this._evGroup && !present.includes(this._evGroup)) present.push(this._evGroup);
    const visibleItems = items.filter((e) => !this._evGroup || this._evPresent(e).g === this._evGroup);
    const pageable = this._evRange === 'day' || this._evRange === 'week';
    const timeFmt = new Intl.DateTimeFormat(lang, { hour: '2-digit', minute: '2-digit' });
    const dayFmt = new Intl.DateTimeFormat(lang, { weekday: 'long', day: 'numeric', month: 'long' });
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);

    let body;
    if (this._evError) {
      body = `<div class="ev-empty"><ha-icon icon="mdi:alert-circle-outline"></ha-icon><div>${T(this._evError)}</div></div>`;
    } else if (this._evItems === null) {
      body = `<div class="ev-empty"><div>${T('loading')}</div></div>`;
    } else if (!visibleItems.length) {
      body = `<div class="ev-empty"><ha-icon icon="mdi:bell-outline"></ha-icon><div class="ev-empty-t">${T('empty')}</div><div class="ev-empty-h">${T('empty_hint')}</div></div>`;
    } else {
      let lastDay = null;
      const multiDay = this._evRange === 'week' || new Date(visibleItems[0].ts).toDateString() !== new Date(visibleItems[visibleItems.length - 1].ts).toDateString();
      body = visibleItems.map((e) => {
        const pr = this._evPresent(e);
        const d = new Date(e.ts);
        let dayHeader = '';
        if (multiDay && d.toDateString() !== lastDay) {
          lastDay = d.toDateString();
          const d0 = new Date(d); d0.setHours(0, 0, 0, 0);
          const diff = Math.round((todayStart - d0) / 86400000);
          const dayName = diff === 0 ? T('today') : diff === 1 ? T('yesterday') : dayFmt.format(d);
          dayHeader = `<div class="ev-day">${dayName}</div>`;
        }
        const isNew = e.ts > (this._evPrevSeen || 0);
        return `${dayHeader}<div class="ev-row${isNew ? ' new' : ''}"><span class="ev-ic c-${pr.c}"><ha-icon icon="${pr.icon}"></ha-icon></span>` +
          `<div class="ev-txt"><div class="ev-t">${pr.title}</div>${pr.detail ? `<div class="ev-d">${pr.detail}</div>` : ''}</div>` +
          `<div class="ev-h">${timeFmt.format(d)}</div></div>`;
      }).join('');
    }

    p.innerHTML = `
      <div class="ev-head">
        <button type="button" class="ev-back" id="ev-back" title="${T('back')}"><ha-icon icon="mdi:chevron-left"></ha-icon></button>
        <div class="ev-title">${T('bell')}</div>
      </div>
      <div class="ev-chips">
        <button type="button" class="ev-chip${this._evGroup ? '' : ' sel'}" data-g="">${T('all')}</button>
        ${present.map((g) => `<button type="button" class="ev-chip${this._evGroup === g ? ' sel' : ''}" data-g="${g}">${T(`g_${g}`)}</button>`).join('')}
      </div>
      <div class="ev-time">
        <select class="ev-range" id="ev-range">
          ${IG_EV_RANGES.map((r) => `<option value="${r}"${this._evRange === r ? ' selected' : ''}>${T(`r_${r}`)}</option>`).join('')}
        </select>
        <div class="ev-nav"${pageable ? '' : ' style="visibility:hidden"'}>
          <button type="button" class="ev-navb" id="ev-prev" title="${T('prev')}"><ha-icon icon="mdi:chevron-left"></ha-icon></button>
          <span class="ev-period">${this._evPeriodLabel()}</span>
          <button type="button" class="ev-navb" id="ev-next" title="${T('next')}"${(this._evOffset || 0) === 0 ? ' disabled' : ''}><ha-icon icon="mdi:chevron-right"></ha-icon></button>
        </div>
      </div>
      <div class="ev-list">${body}</div>
    `;
    p.querySelector('#ev-back').addEventListener('click', (ev) => { ev.stopPropagation(); this._closeEvents(); });
    p.querySelectorAll('.ev-chip').forEach((b) => b.addEventListener('click', (ev) => {
      ev.stopPropagation(); this._evGroup = b.getAttribute('data-g') || null; this._renderEvents();
    }));
    p.querySelector('#ev-range').addEventListener('change', (ev) => {
      this._evRange = ev.target.value; this._evOffset = 0; this._evItems = null; this._renderEvents(); this._loadEvents();
    });
    const shiftPage = (d) => { this._evOffset = Math.max(0, (this._evOffset || 0) + d); this._evItems = null; this._renderEvents(); this._loadEvents(); };
    p.querySelector('#ev-prev').addEventListener('click', (ev) => { ev.stopPropagation(); shiftPage(1); });
    p.querySelector('#ev-next').addEventListener('click', (ev) => { ev.stopPropagation(); shiftPage(-1); });
  }

  // Width of §1.9's side rail. NARROW: only what the touch target takes up, because
  // whatever width the rail takes is height the video loses.
  static get RAIL_WIDTH() { return 104; }

  // ============================================================================================
  // RAIL ENTRY HYSTERESIS (Iñaki, 2026-09-08, after reviewing the fix above)
  //
  // With a single threshold (RAIL_WIDTH), the "vertical tablet + vertical video" case barely scraped by:
  // 116px of leftover space measured against a 104px threshold - only 12px of margin. That's NOT an
  // accuracy problem (the math is done right), it's a STABILITY problem: a real device
  // can give 116 on one redraw and 102 on the next due to a different sub-pixel rounding
  // (_applyFeedAspect's 72vh and the frame's aspect-ratio already produce fractional
  // values - feedWrap.height has been measured at 866, 1070.75, 614, 1154... never clean
  // integers). Crossing a single threshold by 12px is exactly the range where that noise decides, and
  // the symptom would be buttons jumping from band to rail and back depending on whichever frame
  // happened to redraw - worse than being stuck wrong in one place.
  //
  // The fix isn't to move the threshold (that just shifts the problem to a different number), it's to have
  // TWO: entering requires more room than staying does. With RAIL_ENTER_MARGIN = RAIL_WIDTH + 32:
  //  - The 32px cushion leaves 20px of clear separation over the measured borderline case (116px), well
  //    above the sub-pixel fractions that cause the real noise.
  //  - The vertical tablet (116px) falls below 136 -> it goes to BAND. That's the decision, not a
  //    regression: with only 12px of leftover space over the rail's width, that spot is a tight fit, and
  //    with hysteresis a "tight fit" isn't enough to ENTER (it would be enough to not leave, if it
  //    were already inside - but here it never gets to enter).
  //  - The real wallpanel (~707px of leftover space) and the rotation case (~707px) still have
  //    plenty of room by either threshold: they don't change.
  //
  // _railActive (per-instance, initialized in the constructor) is the memory that's needed:
  // without knowing which side you're on right now, there's no way to know which of the two thresholds to compare against.
  static get RAIL_ENTER_MARGIN() { return IgDoorbellView.RAIL_WIDTH + 32; }

  // Content ALREADY ORIENTED as it would look on screen, applying the software rotation if there
  // is one: `videoWidth`/`videoHeight` are ALWAYS the sensor's raw image, exactly as it arrives, before
  // any CSS `rotate()` - the axis swap has to be undone/applied ourselves
  // to know the actual shape of what the user is seeing. 0x0 until the <video>
  // has metadata (see the 'loadedmetadata' listener in render()).
  _contentSize() {
    const v = this.videoEl;
    const rawW = v ? v.videoWidth : 0;
    const rawH = v ? v.videoHeight : 0;
    const rotSwap = (this._rot === 90 || this._rot === 270);
    return rotSwap ? { w: rawH, h: rawW } : { w: rawW, h: rawH };
  }

  _layoutRotation() {
    if (!this.videoEl || !this.feedWrap) return;
    const v = this.videoEl;
    const w = this.feedWrap.clientWidth;
    const h = this.feedWrap.clientHeight;
    const rotSwap = (this._rot === 90 || this._rot === 270);

    // ==========================================================================================
    // SIDE RAIL (§1.9 + §1.7 + §1.9-bis + §1.9-ter): the right question is NOT "am I
    // rotating with CSS?" but "is there leftover width on the sides?". Until 2026-09-08 the condition was
    // `this._rot === 90 || 270` - meaning it REQUIRED a software rotation to activate. On
    // Iñaki's real doorbell the stream already arrives in portrait FROM THE SENSOR (`_rot` stays at 0,
    // nothing to rotate) and that condition was never even evaluated: the rail never triggered, neither in normal
    // mode nor in fullscreen - which is exactly where it looks worst, because there the frame IS
    // edge-to-edge landscape and the empty black bars are huge. Measured on a real Android WebView
    // (Galaxy Tab, 2026-09-08): bottom band covering the image in both modes.
    //
    // The already-oriented image (applying the rotation if there is one, see _contentSize()) is the one that has
    // to be compared against the frame: if it's narrower than the frame at the available height (with
    // object-fit:contain, which the <video> already uses), there's leftover width on both sides, and THAT
    // leftover is what can house the rail - whether there's rotation involved or not.
    let rail = false;
    let gapAfterImage = 0; // see "ANCHORING TO THE IMAGE'S EDGE" further below
    const content = this._contentSize();
    if (content.w > 0 && content.h > 0 && content.h > content.w && w > 0 && h > 0) {
      // Scaled by HEIGHT: with content narrower than the frame (the case at hand,
      // portrait inside landscape), object-fit:contain fills the whole height and the width falls
      // short - exactly the same calculation the browser does, done here to know HOW MUCH
      // is left over before reserving anything.
      const shownWidth = content.w * (h / content.h);
      const sparePerSide = (w - shownWidth) / 2;
      // Hysteresis (see RAIL_ENTER_MARGIN above): which threshold applies depends on where you
      // are RIGHT NOW. Already inside the rail, it's enough to keep fitting (RAIL_WIDTH, what it truly
      // takes up). Outside the rail, the extra cushion is needed to enter - that's what stops
      // a leftover that barely scrapes by (measured: 116px, the vertical-tablet case) from oscillating
      // between band and rail from one redraw to the next.
      const threshold = this._railActive ? IgDoorbellView.RAIL_WIDTH : IgDoorbellView.RAIL_ENTER_MARGIN;
      // ⚠️ (1.10.0) RAIL AND STACK ARE MUTUALLY EXCLUSIVE. With both active at once (seen on Iñaki's
      // PC Panel, with `height:` in the YAML, and on any landscape phone) the
      // `.ig-stack .actions-row` rules win the `position: static` but do NOT cancel the `translateY(-50%)`,
      // the 104px width, nor the `.ig-rail .actions-row` column: the button column ended up
      // shifted up by half its height, with the mic STRADDLING the video's bottom edge and the rest
      // scattered around. In stack mode the buttons already live outside the image: there's no rail to place.
      // ⚠️ (1.11.0) AND ONLY IN FULLSCREEN, AND NEVER UNDER SIDE_MIN_H. Outside fullscreen the
      // side column (layout 'side', see _planLayout) does this job, hugging the image from OUTSIDE
      // the frame; a rail inside an embedded frame was a fourth layout competing with the other three.
      // And under 350 px of height the rail's three buttons + labels (~300 px) don't fit: that is how
      // a phone in landscape lost the mic below the screen edge (1.10.0 analysis).
      rail = sparePerSide >= threshold && !this.content.classList.contains('ig-stack') &&
        !!this._fsActive && h >= IgDoorbellView.SIDE_MIN_H;
      // ---- ANCHORING TO THE IMAGE'S EDGE, not the frame's (Iñaki, 2026-09-08, after seeing the
      // screenshot of the real wallpanel) --------------------------------------------------------
      // The root cause: these rules were brought over from fullscreen, where the FRAME IS THE
      // SCREEN - there "stuck to the frame's right edge" and "stuck to the image" are almost the
      // same thing. In the embedded card the frame is the dashboard's width, that assumption vanishes,
      // and "stuck to the frame" leaves the rail ~700px away from the image on the real wallpanel (measured).
      //
      // The video NO LONGER shrinks to make room for the rail (see further below: v.style.width
      // is always left at '', and usableWidth no longer subtracts RAIL_WIDTH) - it always fills the whole frame and
      // centers itself via object-fit:contain, exactly as if there were no rail. The rail lives
      // INSIDE the margin that natural centering already leaves empty on the right (the same
      // `sparePerSide` from above), stuck to the image's real edge, not the frame's.
      //
      // `--ig-rail-gap` (a CSS variable on .ig-container, consumed by .actions-row,
      // .feed-wrap::after and the .hud-bottom/.status-line offset in the stylesheet)
      // is the gap left BETWEEN the rail's right edge and the frame's right edge -
      // "what's left of the leftover" after reserving RAIL_WIDTH for the rail itself. With the rail
      // stuck to right:var(--ig-rail-gap) and width RAIL_WIDTH, its LEFT edge lands exactly
      // at `w - sparePerSide`, which is the centered image's real right edge - with no
      // dead gaps in between, whatever sparePerSide happens to be.
      //
      // DECISION (Iñaki, 2026-09-08): the image+rail block does NOT stay centered as a whole in
      // the frame - the image stays exactly where object-fit:contain would center it WITHOUT
      // the rail (sparePerSide on each side), and the rail then gets added on top, eating
      // only into the right margin. That leaves ~RAIL_WIDTH more empty space on the left than on the
      // right of the whole (measured on the real wallpanel: ~707px vs ~603px). NOT COMPENSATED ON
      // PURPOSE: the only way to center the whole would be to shift the image away from the frame's
      // center, and on a video doorbell a centered image is worth more than a centered whole - the
      // ~104px difference is barely noticeable, but moving the image off its center WOULD be noticeable,
      // always, on every startup. If this asymmetry "looks wrong" in some future review, the
      // answer isn't to recenter here: it's the one already given once.
      if (rail) gapAfterImage = Math.max(0, sparePerSide - IgDoorbellView.RAIL_WIDTH);
    }
    this._railActive = rail;
    if (this.content) {
      this.content.classList.toggle('ig-rail', rail);
      this.content.style.setProperty('--ig-rail-gap', `${gapAfterImage}px`);
      // The rail's width is also exposed as a variable (not just the gap after it): the
      // stylesheet needs `gap + RAIL_WIDTH` to reach the image's LEFT edge (see
      // .status-line further below), and computing it with a loose "104" in the stylesheet would be
      // duplicating the constant - exactly the kind of number that drifts out of sync if someone changes
      // RAIL_WIDTH here and forgets to touch the other place.
      this.content.style.setProperty('--ig-rail-width', `${IgDoorbellView.RAIL_WIDTH}px`);
    }

    if (!rotSwap) {
      // Without software rotation: the <video> needs no JS measurement, rail or no rail - the
      // stylesheet's `width/height:100%; object-fit:contain` always handles it the same way. The
      // rail doesn't take any room from the video (see the block above): it lives in the margin
      // object-fit already naturally leaves empty.
      v.style.position = '';
      v.style.left = ''; v.style.top = '';
      v.style.transform = this._rot === 180 ? 'rotate(180deg)' : '';
      v.style.width = '';
      v.style.height = '';
      return;
    }
    if (!w || !h) return; // still no layout (hidden card, background tab): the RO will come back eventually

    // The box is declared with width and height SWAPPED and rotated around its center: after the
    // rotation it exactly fills the WHOLE frame (usableWidth no longer subtracts RAIL_WIDTH: the rail doesn't
    // take any room from the video, see the block above), and `object-fit: contain` centers the
    // portrait image inside without cropping anything - the rail lives in the margin that centering already leaves.
    const usableWidth = Math.max(80, w);
    v.style.position = 'absolute';
    v.style.width = `${h}px`;
    v.style.height = `${usableWidth}px`;
    v.style.left = `${usableWidth / 2}px`;
    v.style.top = '50%';
    v.style.transform = `translate(-50%, -50%) rotate(${this._rot}deg)`;
  }

  render() {
    if (!this.content) {
      // Visual language aligned with the real Figma mockup (android_app/ios_app, 2026-07-10 -
      // see COORDINATION.md Q22-bis in ig_hassio_addons): exact palette, rounded video
      // frame with the HUD overlaid INSIDE the video itself (LIVE + time, "Audio active",
      // "Motion detected"), asymmetric action buttons (mic as the star/door as
      // secondary), status line under the video, and mode chips. The mockup elements
      // that do NOT apply to an HA card (branding header, row of links to "screens") were
      // deliberately left out, see that same entry. The doorbell selector, which was also
      // on that list ("one card = one device"), DOES exist since 1.10.0.
      this.innerHTML = `
        <ha-card>
          <div class="ig-container">

            <!-- Header (v1.9.5, Inaki 2026-09-25 afternoon): "REC and the bell must have the
                 same look [as in the apps]" and "the modes must also be a dropdown chip".
                 Replaces that same morning's decision to put REC in the button row next to
                 sound/mic/unlock (see .actions-row below, which keeps those three) - seen next
                 to the real app, REC there looked "very different". Here we reproduce the same
                 row the apps use over the video (mode on the left, REC on the right - see
                 BellWithRec in live_view_body.dart), although in this card it lives OUTSIDE the
                 video (above it), not overlaid - the card already reserved this space since
                 2026-07-10 and changing that is more risk than a look change calls for. NO bell:
                 this card has no "notification history" view to open into it (the app's opens
                 its own screen) - none is invented here, see this repo's CLAUDE.md/COORDINATION.md. -->
            <div class="top-row" id="top-row">
              <div class="top-left">
                <!-- Doorbell selector (1.10.0): dot + name (dname, never the id) + double chevron
                     ONLY if there is something to choose from -- same pattern as
                     DoorbellCapsule/DoorbellPicker in the apps. The dot is the session state of
                     THIS instance (_setLiveState). -->
                <div class="db-picker" id="db-picker">
                  <button type="button" class="db-pill" id="db-pill">
                    <span class="db-dot" id="db-dot" data-state="connecting"></span>
                    <span class="db-name" id="db-name"></span>
                    <ha-icon class="db-chev" id="db-chev" icon="mdi:unfold-more-horizontal" style="display:none;"></ha-icon>
                  </button>
                  <div class="db-menu" id="db-menu" style="display:none;"></div>
                </div>
                <div class="mode-row" id="mode-row" style="display:none;"></div>
              </div>
              <div class="top-right">
                <div class="rec-action-wrap" id="rec-action" style="display:none;">
                  <button type="button" id="rec-button" class="rec-pill" aria-label="REC">
                    <span class="rec-dot" id="rec-dot"></span>
                    <span class="rec-pill-label" id="rec-lbl">REC</span>
                  </button>
                </div>
                <!-- Bell (1.9.7): like the one in the apps (bell_button.dart) - surf2 circle, red
                     dot with no number if there are new notifications. Opens the notifications
                     panel (#ev-panel). -->
                <button type="button" class="bell-btn" id="bell-btn" style="display:none;">
                  <ha-icon icon="mdi:bell-outline"></ha-icon>
                  <span class="bell-dot" id="bell-dot"></span>
                </button>
              </div>
            </div>

            <div class="feed-wrap" data-state="connecting">
              <div class="ig-loader-overlay" id="ig-loader">
                <div class="ig-ring"></div>
                <div class="ig-logo">IG</div>
              </div>

              <div class="video-wrapper">
                <video id="video-player" autoplay playsinline muted></video>
              </div>

              <div class="hud-top">
                <div class="hud-top-left">
                  <div class="live-tag" id="live-tag" data-state="connecting">
                    <div class="reddot"></div>
                    <span class="status-badge">${getLocalText(this._hass, 'connecting')}</span>
                  </div>
                  <!-- WebRTC client counter (API_CONTRACT.md §1.4-ter #2, session_info message).
                       Hidden while the device has NEVER sent it - firmware older than the
                       contract does not send it, and a made-up "1" would be worse than showing
                       nothing at all. -->
                  <div class="clients-pill" id="clients-pill" style="display:none;" title="${getLocalText(this._hass, 'clients_tip')}">
                    <ha-icon icon="mdi:account-multiple"></ha-icon>
                    <span id="clients-count">1</span>
                  </div>
                </div>
              </div>

              <div class="motion-pill" id="motion-pill" style="display:none;">
                <ha-icon icon="mdi:motion-sensor"></ha-icon>
                <span>${getLocalText(this._hass, 'motion_detected')}</span>
              </div>

              <div class="hud-bottom">
                <div class="audio-pill" id="audio-pill" style="display:none;">
                  <ha-icon icon="mdi:microphone"></ha-icon>
                  <span>${getLocalText(this._hass, 'audio_active')}</span>
                </div>
                <div class="hud-bottom-right">
                  <!-- (1.10.0) There used to be "signal" bars here (.hud-sig) that just repeated
                       via CSS the connection's data-state (already visible in the live-tag): they
                       were not RSSI nor the apps' quality chip, and did not respond to anything.
                       Removed (Inaki). -->
                  <!-- Fullscreen. Last item of the right cluster, which is where anyone who has
                       used a video player expects it. Stays visible WHILE in the mode (switching
                       to "exit"): it is the only guaranteed way out, because ESC only exists with
                       a keyboard and the CSS fallback has no way out of the browser. -->
                  <button type="button" class="hud-fs" id="fs-btn" title="${getLocalText(this._hass, 'fs_enter')}">
                    <ha-icon id="fs-icon" icon="mdi:fullscreen"></ha-icon>
                  </button>
                </div>
              </div>

              <!-- Status line + action buttons: INSIDE feed-wrap itself, floating over the video
                   image (Inaki, 2026-09-07: "for a universal solution that works on any device,
                   it's better for the card to put those buttons INSIDE the video image itself, at
                   the bottom"). They used to be siblings of feed-wrap, outside the video with a
                   status line in between - on a landscape wallpanel (wall tablet, the card never
                   leaves that mode) they ended up below the fold and opening the door needed
                   scrolling, exactly what a wall panel cannot demand. They live in here so that
                   the absolute positioning of .actions-row/.status-line (see CSS) is relative to
                   the real VIDEO FRAME and not to the whole card container (which also includes
                   .mode-row above it, of variable height) - the exact same trick fullscreen
                   already used, where it worked only because there the container DOES match the
                   video frame. -->
              <div class="status-line" id="status-line"></div>

              <div class="actions-row">
                <div class="action">
                  <!-- Street speaker (API_CONTRACT.md §1.10): relocated from the HUD (bottom-right
                       corner) to the main button row, next to mic/unlock/REC, to look like the
                       apps' layout (Inaki, 2026-09-25: "sound, mic, unlock, REC"). The volume
                       slider IS REMOVED at the same time (separate decision the same day: "no
                       client has it in its live view, not here either" - the volume is the
                       device's own). Starts MUTED, as always (see it is not listening). -->
                  <button type="button" id="snd-btn" class="btn snd" aria-pressed="false" title="${getLocalText(this._hass, 'snd_off')}">
                    <ha-icon icon="mdi:volume-off" id="vol-icon"></ha-icon>
                  </button>
                  <span class="lbl" id="snd-lbl">${getLocalText(this._hass, 'snd_off')}</span>
                </div>
                <div class="action">
                  <button id="mic-button" class="btn mic" disabled>
                    <div class="pulsering"></div>
                    <ha-icon icon="mdi:microphone-off"></ha-icon>
                  </button>
                  <span class="lbl" id="mic-lbl">${getLocalText(this._hass, 'lbl_mic_off')}</span>
                </div>
                <div class="action">
                  <button id="unlock-button" class="btn door" disabled>
                    <ha-icon icon="mdi:lock-open-variant"></ha-icon>
                  </button>
                  <span class="lbl" id="unlock-lbl">${getLocalText(this._hass, 'lbl_door_idle')}</span>
                </div>
                <!-- REC (recordings v2, Inaki 2026-09-25) NO LONGER LIVES HERE (v1.9.5, the same
                     afternoon): see the rec-action block in the header (top-row) above, with its
                     full reasoning. The button still calls the auto-detected rec_entity's service
                     (_toggleRec()/_updateRecButton()) exactly as before - the only thing that
                     changes is the look and where it lives, not the behavior ("the card DISPLAYS,
                     the integration EXPOSES", decision 2026-08-31). -->
              </div>
            </div>

            <!-- Recordings (v1.9.5, Inaki 2026-09-25): "we don't add a settings button (that's
                 what the integration is for), but we DO add the Recordings one", with the same
                 look as the apps' _QuickButton (icon in a rounded box + label). Same admin
                 criterion as REC (_connInfo.role, not hass.user.is_admin - see
                 _updateRecordingsButton()) and no Settings: configuration lives in the
                 integration and its entities, not here. Opens Home Assistant's native media
                 browser against the media_source the integration already exposes
                 (media_source.py/DoorbellMediaSource) - the card does NOT reimplement a player,
                 see _openRecordings(). -->
            <!-- Quick reply (v1.9.8, Inaki 2026-09-25): "to avoid taking up more space, split the
                 Recordings bar into two buttons: Recordings and Quick replies" -- NOT a new row,
                 the SAME wide row as always split into two halves (same shape iOS/Android give
                 the button, no chevron: it doesn't fit with two buttons at 375-390px). Recordings
                 stays admin-only (_updateRecordingsButton); Quick replies is visible to any user,
                 same as ?quick=1 on the doorbell itself (§1.18.8) -- see
                 _updateQuickReplyButton(). If one of the two is hidden the other one takes the
                 whole row on its own (flex:1 on .quick-btn.half), with no separate CSS for that
                 case. Opens #qr-panel (same pattern as the bell/#ev-panel): a list requested from
                 the integration (ig_doorbell/get_quick_replies, LAN, no credential) and
                 triggered with the play_sequence service that has existed since Phase 0 -- that
                 service already handles the doorbell-ring case (§1.18.1) with nothing special
                 here, see _playQuickReply(). -->
            <!-- Buttons in STACK MODE (1.9.7): on a phone in portrait the button row leaves the
                 video and lives here, below the chips, as in the apps. _fitToSpace() moves it. -->
            <div class="stack-controls" id="stack-controls"></div>
            <!-- SIDE COLUMN (1.11.0): empty until _placeControls() moves the header, the buttons
                 and the Recordings row into it (layout 'side'). Hidden in the other layouts. -->
            <div class="side-col" id="side-col"></div>

            <div class="bottom-row" id="bottom-row" style="display:none;">
              <button type="button" id="recordings-button" class="quick-btn half">
                <span class="quick-btn-icon"><ha-icon icon="mdi:play-box-multiple-outline"></ha-icon></span>
                <span class="quick-btn-label">${getLocalText(this._hass, 'recordings_title')}</span>
              </button>
              <button type="button" id="qr-button" class="quick-btn half">
                <span class="quick-btn-icon"><ha-icon icon="mdi:message-reply-text-outline"></ha-icon></span>
                <span class="quick-btn-label">${getLocalText(this._hass, 'quick_reply_title')}</span>
              </button>
            </div>

            <div class="ev-panel" id="ev-panel" style="display:none;"></div>
            <div class="ev-panel" id="qr-panel" style="display:none;"></div>

          </div>
        </ha-card>
      `;

      this.content = this.querySelector('.ig-container');
      this.feedWrap = this.querySelector('.feed-wrap');
      this.videoEl = this.querySelector('#video-player');
      this.micButton = this.querySelector('#mic-button');
      this.micIcon = this.querySelector('#mic-button ha-icon');
      this.micLabel = this.querySelector('#mic-lbl');
      this.badge = this.querySelector('.status-badge');
      this.liveTag = this.querySelector('#live-tag');
      this.audioPill = this.querySelector('#audio-pill');
      this.motionPill = this.querySelector('#motion-pill');
      this.statusLine = this.querySelector('#status-line');
      this.modeRow = this.querySelector('#mode-row');
      this.unlockButton = this.querySelector('#unlock-button');
      this.unlockIcon = this.querySelector('#unlock-button ha-icon');
      this.unlockLabel = this.querySelector('#unlock-lbl');
      this.volIcon = this.querySelector('#vol-icon');
      this.sndBtn = this.querySelector('#snd-btn');
      this.sndLabel = this.querySelector('#snd-lbl');
      this.recAction = this.querySelector('#rec-action');
      this.recButton = this.querySelector('#rec-button');
      this.recDot = this.querySelector('#rec-dot');
      this.recLabel = this.querySelector('#rec-lbl');
      this.recordingsAction = this.querySelector('#bottom-row');
      this.recordingsButton = this.querySelector('#recordings-button');
      this.qrButton = this.querySelector('#qr-button');
      this._qrPanel = this.querySelector('#qr-panel');
      this.topRow = this.querySelector('#top-row');
      this._dbPill = this.querySelector('#db-pill');
      this._dbDot = this.querySelector('#db-dot');
      this._dbName = this.querySelector('#db-name');
      this._dbChev = this.querySelector('#db-chev');
      this._dbMenu = this.querySelector('#db-menu');
      this._dbPill.addEventListener('click', (ev) => { ev.stopPropagation(); this._toggleDbMenu(); });
      this._paintPicker();
      this.stackControls = this.querySelector('#stack-controls');
      this.sideCol = this.querySelector('#side-col');
      this.actionsRow = this.querySelector('.actions-row');
      this._bellBtn = this.querySelector('#bell-btn');
      this._bellDot = this.querySelector('#bell-dot');
      this._evPanel = this.querySelector('#ev-panel');
      this._bellBtn.addEventListener('click', (ev) => { ev.stopPropagation(); this._openEvents(); });
      this.loader = this.querySelector('#ig-loader');
      this.clientsPill = this.querySelector('#clients-pill');
      this.clientsCount = this.querySelector('#clients-count');
      this.qualityCtl = this.querySelector('#hud-quality');
      this.qualityBtn = this.querySelector('#q-btn');
      this.qualityIcon = this.querySelector('#q-icon');
      this.qualityLabel = this.querySelector('#q-label');
      this.qualityMenu = this.querySelector('#q-menu');
      this.fsBtn = this.querySelector('#fs-btn');
      this.fsIcon = this.querySelector('#fs-icon');

      // Fullscreen. The click carries stopPropagation for the same reason as the
      // quality selector: there's a document-level listener that closes its menu.
      this.fsBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this._toggleFullscreen();
      });

      // Dropdown mode chip (v1.9.5): a click outside closes it, same criterion as the
      // (retired) quality menu from earlier versions. It's kept bound to the instance so it
      // can be removed in disconnectedCallback() and not accumulate listeners if Home Assistant
      // re-inserts this same card (Lovelace view change, see disconnectedCallback()).
      this._onDocClickForModeMenu = () => { this._toggleModeMenu(false); this._toggleDbMenu(false); };
      document.addEventListener('click', this._onDocClickForModeMenu);

      // Recordings (v1.9.5): navigates to Home Assistant's NATIVE media browser (never a
      // player of our own, see the comment next to #bottom-row's markup) via the same
      // SPA navigation convention the whole frontend uses (history.pushState +
      // 'location-changed') - _openRecordings() explains the URL's exact format.
      this.recordingsButton.addEventListener('click', () => this._openRecordings());
      // Quick reply (v1.9.8): opens #qr-panel, same pattern as the bell (#ev-panel).
      if (this.qrButton) this.qrButton.addEventListener('click', () => this._openQuickReplies());
      // The life watchdog only checks every 5s, and the status chip shouldn't spend 5s
      // lying. The <video>'s own 'timeupdate' fires several times a second as soon as the
      // image genuinely advances, which is exactly the signal that should drive this here. The cost is
      // one string comparison: _confirmLiveFromMedia() bails out on the first line unless the
      // chip is actually wrong.
      this.videoEl.addEventListener('timeupdate', () => this._confirmLiveFromMedia());

      // The side rail (see _layoutRotation) AND the frame's shape (see _applyFeedAspect)
      // decide by looking at videoWidth/videoHeight, which are 0x0 until the <video> has
      // metadata - without this pair of listeners, a real startup (where both functions get
      // called BEFORE they arrive) would be stuck with the startup guess forever,
      // exactly the symptom that motivated this rewrite (measured on a real Galaxy Tab,
      // 2026-09-08). 'resize' also covers a HOT resolution change (e.g. the quality
      // selector, §1.4-ter #3) after metadata already existed.
      this.videoEl.addEventListener('loadedmetadata', () => { this._applyFeedAspect(); this._layoutRotation(); });
      this.videoEl.addEventListener('resize', () => { this._applyFeedAspect(); this._layoutRotation(); });

      this._registerFullscreenListeners();
      this._applyDoorAvailability();

      // The "configurable height" applies to the VIDEO FRAME (.feed-wrap), not the whole card - the
      // card now also has the mode row/status line/buttons outside the video, which
      // must keep their natural height instead of being squeezed inside a measurement meant only
      // for the video. The shape (16:9 or 9:16) is decided by the known rotation, see _applyFeedAspect().
      this.feedWrap.setAttribute('data-rot', String(this._rot));
      this._applyFeedAspect();
      this._layoutRotation();
      this._setupZoom();

      // Rotating by 90/270 swaps width and height, and that can't be written in CSS without knowing
      // the frame's real size - hence the observer. It only fires when the layout genuinely
      // changes (resizing the window, switching views, entering fullscreen), not on
      // every video frame.
      if (typeof ResizeObserver === 'function') {
        this._feedRO = new ResizeObserver(() => { this._layoutRotation(); this._zoomClamp(); });
        this._feedRO.observe(this.feedWrap);
      } else {
        this._onWindowResizeForRot = () => this._layoutRotation();
        window.addEventListener('resize', this._onWindowResizeForRot);
      }
      this._registerFitObservers();

      // Only path: native 'open'/'open_result' signaling message (API_CONTRACT.md §3.3).
      // `unlock_entity` was retired in 1.10.0: if the door is a Home Assistant entity, the
      // doorbell itself triggers it (door_m=1), configured in the integration.
      // Double tap (§1.8): the click does NOT open, it arms; the second one opens. See _onDoorPress().
      this.unlockButton.addEventListener('click', () => this._onDoorPress());

      this.micButton.addEventListener('click', () => this.toggleTalk());

      // The volume control IS REMOVED from the card (Iñaki, 2026-09-25: "no client has it
      // in the card. Not here either" - neither iOS nor Android has a slider in their live view,
      // volume belongs to the device itself). What's left is only §1.10's sound
      // switch (hear the street or not), now just another button in the action row. The <video> is always
      // left at volume 1 (see setupRemoteStream) and the only thing that changes is `.muted`.
      this._paintAudioState();
      this.sndBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this._setAudioOn(!this._audioOn, 'user');
      });

      // REC (recordings v2, §1.4-quater): optional button, only with `rec_entity` configured and the
      // integration paired as the doorbell's administrator (1.9.4) - see
      // _updateRecButton()/toggleRec().
      this.recButton.addEventListener('click', () => this.toggleRec());

      this.injectStyles();
      this._updateHassBoundUI();
      if (!this._restoreSavedPause()) this.startWebRTC('render: first construction of the card\'s DOM');
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════
  //  THE ONLY ENTRY POINT FOR A CONNECTION -- and since 2026-09-07, the only guard.
  //
  //  ⚠️ `!this.pc` AT THE CALL SITE IS NOT A GUARD, AND IT CAN'T BE TRUSTED AS ONE AGAIN.
  //  `this.pc` isn't assigned until after two waits (one of them, TURN credentials against
  //  a server in Germany), so during that whole stretch it's `null` and ANY number of
  //  invocations passes the filter at the same time. The five call sites still have it in front
  //  and it's fine that they do -- it saves a call in the common case -- but it's an optimization,
  //  not a defense. The defense is in here, where nobody can forget to put it.
  //
  //  `motivo` isn't decoration: when this gets discarded or supersedes someone, the only thing left
  //  in the panel's console is that string. Without it, "a startup was discarded" doesn't say which
  //  of the five paths triggered it, which is half the useful information.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  async startWebRTC(reason = 'no reason given') {
    if (this._destroyed) return;  // (1.10.0) instance of a doorbell that's no longer being viewed: see _destroy()
    // While paused, nothing starts: only _resume() lifts it (clearing it first), or nobody.
    if (this._pauseState) {
      console.info(`[ig-doorbell-card] paused (${this._pauseState.reason}): not starting (${reason})`);
      return;
    }
    const inFlight = this._startInFlightGen;
    // Only blocks the one that's still CURRENT. A startup whose session has already been torn down
    // out from under it (e.g. _scheduleReconnect(), which tears down and starts again 2 s later) is
    // doomed and must not block its successor. See the GENERATION block in the constructor.
    if (inFlight !== null && inFlight === this._connGen) {
      const inFlightAge = Date.now() - this._startInFlightAt;
      if (inFlightAge < START_IN_FLIGHT_MAX_MS) {
        console.info(`[ig-doorbell-card] a startup is already in flight (${inFlightAge}ms) - letting it finish, not launching another (${reason})`);
        return;
      }
      // Fuse (see START_IN_FLIGHT_MAX_MS above). Logged as WARN on purpose: if this
      // shows up in a log, there's a path getting stuck with no deadline of its own and it needs fixing
      // there. This is the net, not the fix.
      console.warn(`[ig-doorbell-card] the in-flight startup has gone ${inFlightAge}ms unresolved - superseding it (${reason})`);
    }

    // Reuses the same cleanup as disconnectedCallback()/_scheduleReconnect() - also defensive
    // against the life watchdog being left "hanging" from a previous session if this
    // function gets called again for another reason (e.g. HA re-renders the card).
    // It also bumps the generation: from this line on, any earlier startup in flight
    // gets superseded and will collect its own instead of writing it on top of ours.
    this._teardownConnectionObjects();
    this._stopRescue();
    // (1.10.0) Every new session is born in 'connecting' (e.g. coming back from a hung-up pause the
    // state was 'paused'): only the first image sets 'live', see setupRemoteStream().
    if (this._liveStateKey !== 'error_cam') this._setLiveState('connecting');
    this._livePauseWanted = false;
    const gen = this._connGen;
    this._startInFlightGen = gen;
    this._startInFlightAt = Date.now();

    // ⚠️ THE IDLE COUNTDOWN GETS ARMED HERE, AND NOT WHERE IT USED TO BE (2026-09-07).
    //
    // It lived inside _acquireWakeLock(), AFTER acquiring the wake lock -- meaning it hung
    // off something that never happens on a wallpanel. `_acquireWakeLock()` is only called on
    // entering fullscreen, and it also bails out on its first line if `navigator.wakeLock` doesn't
    // exist in that webview. Result: on the living-room Galaxy Tab NO CLOCK EVER GOT ARMED, and
    // that's why v1.5.0, v1.5.1 and v1.6.0 -- three versions in a row fixing the deadline -- all failed
    // identically: they weren't fixing the deadline, they were fixing a clock that didn't exist.
    //
    // It was given away by a measurement that was already on the table: the `SCREEN_BRIGHT_WAKE_LOCK`
    // that `dumpsys power` showed was a WINDOW lock with a fixed id, held continuously -- meaning
    // it wasn't ours, it was kept by the <video> playing itself. Our own wake lock didn't
    // even exist.
    //
    // Releasing the screen doesn't depend on the wake lock and never did: when the deadline expires what
    // happens is the STREAM GETS TORN DOWN (see the timer), and once the <video> stops the browser
    // releases its window lock on its own. So the countdown has to hang off the one thing that
    // genuinely justifies it -- there being a session -- and that's exactly here.
    this._armIdleWakeLockTimer();

    try {
      await this.startNativeSession(gen);
    } finally {
      // Only whoever took it releases it. If another startup supersedes us while we were waiting, the
      // marker is already THEIRS, and clearing it here would reopen the door to reentrancy.
      if (this._startInFlightGen === gen) this._startInFlightGen = null;
    }
  }

  // `true` if another teardown or startup has superseded us while we were waiting. Whoever reads it has
  // to CLOSE ITS OWN before leaving: releasing it without closing it is exactly the leak all this
  // exists to fix -- an orphaned WebSocket occupies a relay client and, if it got as far as requesting
  // the offer, it holds on to one of the doorbell's four slots for the whole house.
  _superseded(gen) { return gen !== this._connGen; }

  // ==============================================================================
  // Speaks the doorbell's own protocol (ICE-Lite + DTLS-SRTP + RTP), direct or via relay.
  // Credentials/host served by the ig_doorbell integration
  // over HA's internal WebSocket API (never pasted by hand in YAML). See
  // API_CONTRACT.md §1.4/§3.2/§3.3 (IG_Doorbell) and ARCHITECTURE.md §5 (ig_hassio_addons).
  // ==============================================================================

  // Real instrumentation with timestamps (added 2026-07-10, see COORDINATION.md - real user
  // report: 10+s for the first frame with the new card, versus ~1s with the old card
  // via go2rtc). _mark() logs every step to the console with the elapsed time since
  // THIS specific session started - meant for diagnosing with real data, not guessing, where
  // the time goes. Lower the log level/remove once the real performance issue is closed.
  _mark(label) {
    if (!this._t0) return;
    const elapsed = Math.round(performance.now() - this._t0);
    console.log(`[ig-doorbell-card timing] +${elapsed}ms  ${label}`);
  }

  // Really releases the WebRTC slot on closing/reloading/navigating away from the page, instead of
  // letting the doorbell evict it only after its own abandonment timeout (~45s) - the same pattern
  // the doorbell's own web dashboard already uses against this same endpoint (a real find,
  // 2026-07-10, see COORDINATION.md). `disconnectedCallback()` (further below) ALREADY sends 'bye' when
  // HA removes this card from the DOM (e.g. switching Lovelace views within the same page)
  // but that Custom Elements hook is NOT guaranteed during a tab/window close or
  // a full reload - the JS runtime can vanish before it gets to run.
  // 'pagehide' IS meant for this, and paired with sendBeacon (for the local path, which uses
  // a normal POST/fetch - an in-flight fetch() gets canceled when the page vanishes, sendBeacon is
  // specifically designed to complete during unload) closes the real gap.
  _registerUnloadHandler() {
    if (this._onPageHide) return; // already registered, avoids duplicates on reconnection
    this._onPageHide = () => this._sendByeOnUnload();
    window.addEventListener('pagehide', this._onPageHide);
  }

  _unregisterUnloadHandler() {
    if (!this._onPageHide) return;
    window.removeEventListener('pagehide', this._onPageHide);
    this._onPageHide = null;
  }

  _sendByeOnUnload() {
    // Local (SSE/POST): sendBeacon instead of fetch() - an in-flight fetch() gets canceled when
    // the page vanishes, sendBeacon is designed to complete regardless during
    // unload. sendBeacon doesn't support custom headers, but a Blob with type "application/json"
    // still makes the browser send the correct Content-Type.
    if (this.nativeSSE) {
      const payload = { type: 'bye' };
      if (this._slot !== null) payload.slot = this._slot;
      const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      // Over the proxy the SIGNED URL is used, not callApi: sendBeacon doesn't support headers, and the signature
      // travels in the URL itself. It's best-effort in the strict sense -- if Home Assistant didn't
      // accept a signature on a POST, the only thing lost is the slot's immediate release,
      // which the doorbell recovers on its own after 20s. This must never be made blocking: the page is
      // already closing.
      // ⚠️ `fetch(..., {keepalive:true})` WITH the Authorization header, and not sendBeacon to the
      // signed URL (1.9.1): a signed Home Assistant route only works for GET, so the beacon
      // got a 401 and `bye` never arrived -- measured: on closing the page the session stayed
      // alive on the doorbell until its own deadline. keepalive survives the close just like a beacon.
      const token = this._hass && this._hass.auth && this._hass.auth.data ? this._hass.auth.data.access_token : null;
      let beaconSent = false;
      if (token && typeof fetch === 'function') {
        try {
          fetch(`/api/${IG_DOMAIN}/signal/${this.config.device_id}`, {
            method: 'POST', keepalive: true, body: JSON.stringify(payload),
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          }).catch(() => {});
          beaconSent = true;
        } catch (err) { /* best effort */ }
      }
      if (!beaconSent && this._localSignedUrl) {
        try { navigator.sendBeacon(this._localSignedUrl, blob); } catch (err) { /* best effort */ }
      }
    }

  }

  async startNativeSession(gen) {
    // `gen` is the generation it was started with (see the GENERATION block in the
    // constructor). It's checked AFTER EVERY WAIT, because each one is a window in which
    // another trigger may have torn down the session and started its own. Without this, this function
    // writes its RTCPeerConnection and WebSocket on top of the current startup's and leaves them
    // open forever -- the measured bug.
    if (this._superseded(gen)) return;
    this._t0 = performance.now();
    this._mark('startNativeSession: start');
    this._registerUnloadHandler();

    // Real bug found and fixed (2026-07-10, see COORDINATION.md - user report: on
    // a cold load of the dashboard, the card briefly shows "Error" before settling into
    // the correct state). Cause: on a cold load, HA can insert the element into the DOM
    // (triggering connectedCallback() -> startWebRTC() -> here) BEFORE the `hass` setter has
    // been invoked with an instance already hydrated with `.connection` ready - a genuine
    // startup race, not a network or configuration bug. Before, this was treated as a
    // TERMINAL error (badge set to "Error" and immediate return, with no reconnection scheduled - unlike
    // any other failure in this function, which does fall into the catch further below and
    // can reconnect via _scheduleReconnect()). In practice, the element gets re-inserted shortly
    // after (HA can move/remount cards during a view's initial hydration), which
    // fires connectedCallback() again with hass already ready - hence the user seeing the
    // error "settle on its own": this function wasn't being fixed, a second attempt with
    // better luck was simply papering over it. Now it retries silently (without touching the badge, which already shows
    // "Connecting..." from the initial HTML) for ~5s before genuinely giving up.
    if (!this._hass || !this._hass.connection) {
      this._hassWaitAttempts = (this._hassWaitAttempts || 0) + 1;
      if (this._hassWaitAttempts <= 20) {
        // The generation travels with the retry: this chain of waits lives OUTSIDE of startWebRTC()'s
        // `await` (that promise already resolved), so it's exactly the kind of queued callback that can
        // wake up when another startup is already in charge.
        setTimeout(() => this.startNativeSession(gen), 250);
        return;
      }
      console.error('[ig-doorbell-card] hass.connection not available after waiting ~5s - cannot request connection info from the ig_doorbell integration');
      this._setLiveState('error_cam');
      this._hassWaitAttempts = 0;
      // Same criterion as the catch further below (2026-07-10, see COORDINATION.md): no failure
      // point in this file should leave the card dead with no way to recover -
      // if hass.connection still hasn't shown up, we keep retrying with backoff instead of
      // giving up forever.
      this._scheduleReconnect('hass.connection not available after waiting ~5s', gen);
      return;
    }
    this._hassWaitAttempts = 0;

    try {
      const info = await this._hass.connection.sendMessagePromise({
        type: `${IG_DOMAIN}/get_connection_info`,
        device_id: this.config.device_id,
      });
      // Wait #1 (HA's WebSocket) passed. If we got superseded here nothing is open yet:
      // it's enough to not write `_connInfo`/`_slot` over the current startup's.
      if (this._superseded(gen)) return;
      this._mark('get_connection_info: response received');
      this._connInfo = info;
      this._slot = null;
      // REC and Recordings depend on `_connInfo.role` (1.9.4/1.9.5, see _updateRecButton()/
      // _updateRecordingsButton()) - they get repainted here instead of waiting for the next
      // `set hass()` tick, which could take a while if HA's state is quiet right after connecting.
      this._updateRecButton();
      this._updateRecordingsButton();
      this._updateQuickReplyButton();
      this._updateBell();

      // Wait #2 (TURN credentials: HTTPS to Germany). THIS is the long one, and the one that opened the
      // window for the measured bug. From here on there ARE objects to close, so being
      // superseded can no longer just mean exiting: it has to clean up.
      const pc = await this.buildNativePeerConnection(gen);
      if (!pc) return;                      // superseded INSIDE build: nothing ever got created
      if (this._superseded(gen)) {            // superseded in the `await` right above
        this._closePeerConnection(pc);
        return;
      }
      this.pc = pc;
      this._mark('buildNativePeerConnection: RTCPeerConnection ready');
      // The clock was armed in startWebRTC() with the fallback deadline, before knowing which entity
      // controls it (arrives in get_connection_info). Now that it's known, the real one is applied.
      this._watchIdleTimeout();

      // Starts the life watchdog FROM HERE - it covers both the negotiation phase (via
      // signaling, see tryLocalSignaling()/startRelaySignaling() below) and, once
      // connected, the video's real progress via getStats() in _checkLifeWatchdog().
      this._startLifeWatchdog();

      this._mark('tryLocalSignaling: starting the local attempt');
      const connectedLocally = await this.tryLocalSignaling(gen);
      this._mark(`tryLocalSignaling: finished (success=${connectedLocally})`);
      // ⚠️ THIS IS THE GUARD THAT WAS MOST NEEDED, and the one that explains the measured signature of three
      // open connections and only one closed. The local path has its own 3 s deadline: an
      // early startup would spend those 3 s waiting for an offer that never arrives, and once done
      // would keep going until opening a WebSocket against the relay -- stepping on the good
      // startup's `nativeWS`, which was left orphaned with nobody ever closing it.
      if (this._superseded(gen)) return;
      if (!connectedLocally) {
        // No cloud fallback, on purpose (phase 0). It's reported that Home Assistant can't reach the
        // doorbell over the LAN and it retries with the usual backoff.
        this._flashStatusLine('conn_lan', 6000);
        this._scheduleReconnect('Home Assistant\'s local proxy is not delivering the offer', gen);
      }
    } catch (err) {
      // A failure from an already-superseded startup isn't news: someone else is in charge, and scheduling a
      // reconnection from here would take down THEIR session. It exits silently, with its own
      // already cleaned up by the guards above.
      if (this._superseded(gen)) return;
      // Real bug found and fixed (2026-07-10, see COORDINATION.md - investigating a
      // persistent "Error" the lead saw on a real card pointing at a device that was
      // probably old/disabled): this catch was the ONLY failure point in the whole
      // file that did NOT schedule a reconnection - unlike nativeWS.onclose,
      // 'sessions_full', connectionState failed/disconnected, the 20s watchdog, and a received
      // 'bye', all of which do call _scheduleReconnect(). If get_connection_info fails (e.g.
      // the device_id no longer has a valid/paired entry in the integration) or
      // startRelaySignaling() rejects (the relay doesn't open the connection, e.g. an unauthorized
      // device), the card was left on "Error" forever, with no retry - matching
      // exactly the symptom of a card showing a persistent "Error" that never recovers
      // on its own. If the device genuinely no longer exists, this simply retries in a loop with
      // backoff (the same principle already established in the life watchdog: better to keep
      // trying silently than to leave the card dead) - consistent with the rest of the file,
      // not new behavior.
      console.error('[ig-doorbell-card] failed starting native session', err);
      this._setLiveState('error_cam');
      // This doorbell is no longer configured on THIS Home Assistant (the integration lost it, or it was
      // removed and re-added with a different entry). Retrying in a loop is correct, but saying
      // nothing leaves the user seeing "Connecting..." forever with no way to know that
      // what's missing is re-pairing. See _reportPairingRejected().
      if (err && err.code === 'not_found') this._reportPairingRejected('get_connection_info: not_found');
      this._scheduleReconnect(`failed starting native session: ${err && err.message ? err.message : err}`, gen);
    }
  }

  // Returns `null` if we got superseded while TURN credentials were being requested. It's checked BEFORE
  // building anything, so in that case there's neither an RTCPeerConnection nor an AudioContext to close
  // -- garbage that's never generated doesn't need collecting.
  async buildNativePeerConnection(gen) {
    // ⚠️ NO STUN OR TURN, ON PURPOSE (phase 0, 2026-09-25). Home Assistant is a LOCAL client: the
    // doorbell offers its LAN host candidate and the browser reaches it directly (measured on
    // 2026-07-29: host <-> host, 2 ms). Until 1.8.x there was a fixed STUN on the VPS and TURN requested
    // from the cloud by the integration; both were paths to the VPS and were removed. Don't bring them back
    // "to view from outside": outside the LAN the card doesn't connect, and that's the rule, not a bug.
    const iceServers = [];
    await Promise.resolve();
    // ⚠️ THE GUARD GOES HERE, BETWEEN THE LAST WAIT AND THE FIRST CONSTRUCTION, and that's not a coincidence:
    // from this line down there isn't a single `await`, so the rest runs in full with
    // nobody able to slip in between (JavaScript is single-threaded). Either we build while
    // still current, or we build nothing at all.
    if (this._superseded(gen)) {
      this._mark('buildNativePeerConnection: superseded while requesting TURN credentials - building nothing');
      return null;
    }

    const pc = new RTCPeerConnection({ iceServers });

    // Muted audio track from startup so as not to block the video behind the microphone
    // permission dialog; replaceTrack() when activating the intercom (see toggleTalk).
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    // Hung off the `pc` itself so whoever closes it can also close this, whether from
    // the normal teardown or the supersession path -- see _closePeerConnection().
    pc.__igAudioCtx = audioCtx;
    const dest = audioCtx.createMediaStreamDestination();
    this.dummyAudioTrack = dest.stream.getAudioTracks()[0];

    this.videoTransceiver = pc.addTransceiver('video', { direction: 'recvonly' });
    // Real bug found and fixed (2026-07-11, see COORDINATION.md Q24/Q24-bis - confirmed
    // with real data from a Playwright test, fake audio device): this line used to be
    // `pc.addTransceiver(this.dummyAudioTrack, { direction: 'sendrecv' })` and the SDP answer
    // generated by this card said `a=recvonly` on the m=audio line, even though
    // `audioTransceiver.direction` read as 'sendrecv' (with mid=null and currentDirection=null,
    // a sign that transceiver NEVER got associated with any m-line).
    //
    // Definitive explanation, with the spec in front (audit 2026-07-12, see memory
    // hass_card_audio_investigation): it's NOT a Chromium bug nor an undocumented nuance - it's
    // specified behavior. When applying a REMOTE OFFER (and the doorbell is ALWAYS the
    // offerer, ICE-Lite, it never processes incoming offers), RFC 9429 (JSEP) §5.10 and the
    // webrtc-pc setRemoteDescription() steps only allow matching an incoming m-line to an
    // existing local transceiver if that transceiver WAS CREATED BY addTrack() - ones created with
    // addTransceiver() are excluded from that matching on purpose (they only get matched when this
    // side generates the offer, which never happens here). Exact consequence of the old
    // version: the explicit transceiver was left orphaned forever, setRemoteDescription()
    // created ANOTHER implicit transceiver for the audio m-line with the default direction
    // 'recvonly', and the answer came out a=recvonly - the browser never sent a single audio RTP
    // packet. Video "worked" with both variants only by coincidence: the implicit
    // transceiver's default ('recvonly') happens to be exactly what video wants. The web dashboard
    // (`main/webtask.c`, in production) uses `pc.addTrack(track)` - the spec-correct route for
    // a peer that always answers offers, not just "the one that happened to work".
    const audioSender = pc.addTrack(this.dummyAudioTrack);
    this.audioTransceiver = pc.getTransceivers().find((t) => t.sender === audioSender) || null;
    console.log(
      '[ig-doorbell-card DIAG audio] audioTransceiver created via addTrack(): ' +
      `direction=${this.audioTransceiver ? this.audioTransceiver.direction : '(not found)'} ` +
      `sender.track=${audioSender.track ? audioSender.track.id : 'null'}`
    );

    // All three handlers have the generation guard up front, and for the same reason in all
    // three: `pc.close()` doesn't flush the browser's already-queued event queue. An `ontrack` from
    // a superseded session would paint its video over the good one; an `onicecandidate` would send a
    // candidate from a dead negotiation over the live one's channel.
    pc.ontrack = (event) => {
      if (this._superseded(gen)) return;
      this.setupRemoteStream(event.streams[0]);
    };

    // The device is ICE-Lite: it only emits its candidate once, in the offer's SDP -
    // but it DOES expect trickle ICE from this side (API_CONTRACT.md §3.3).
    pc.onicecandidate = (e) => {
      if (this._superseded(gen)) return;
      if (e.candidate) this.sendNativeSignal({ type: 'candidate', candidate: e.candidate.candidate });
    };

    pc.onconnectionstatechange = () => {
      if (this._superseded(gen)) return;
      this._mark(`RTCPeerConnection.connectionState -> ${pc.connectionState}`);
      // AGGRESSIVE shortcut (2026-07-10, user decision, see COORDINATION.md Q19 - same
      // criterion android_app uses in its own watchdog): both 'failed' AND 'disconnected'
      // trigger immediate reconnection, without waiting out the rest of the life watchdog's 20s
      // clock - knowingly, since 'disconnected' can be transient (a normal
      // ICE recovery could get interrupted every now and then). A conscious decision to
      // validate live against poor 4G/5G coverage, not an oversight. This also closes at the root
      // the case that used to be worrying (local signaling "succeeding" but the real connection failing
      // afterwards with no fallback) - now there IS a fallback: reconnect, which retries
      // local-first-then-remote from scratch.
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        this._scheduleReconnect(`RTCPeerConnection.connectionState=${pc.connectionState}`, gen);
      }
    };

    return pc;
  }

  // Tries the local path first: the doorbell's own real HTTPS
  // (`https://<device_id>.doorbell.islautopia.com:8443/webrtc/signal`, API_CONTRACT.md §1.4).
  // Deliberately, a "bare IP + HTTP" candidate is NEVER tried here: if HA's dashboard is
  // served over HTTPS, the browser would block that fetch as "mixed content"; if it's served
  // over HTTP, the microphone is already blocked by the browser for the whole page
  // regardless of who the card talks to (a "secure context" limitation of HA's own
  // origin, not of this card - see ARCHITECTURE.md, the note on mixed content). Always using
  // the real hostname (never an IP) is also mandatory for the doorbell's
  // Let's Encrypt certificate to validate correctly.
  //
  // Auth (added 2026-07-09, see COORDINATION.md): /webrtc/signal and /webrtc/signal/post no longer
  // accept connections without a credential - "?token=<pair_app credential>" is needed in the URL
  // (EventSource doesn't support custom headers, hence the query param instead of Authorization).
  // It's the SAME credential already requested for the remote WS (this._connInfo.credential) - an
  // invalid/missing token gives 401 instead of the offer.
  // ==============================================================================
  // THE LOCAL PATH, IN TWO VARIANTS (2026-08-03)
  //
  // The Home Assistant integration's own signaling proxy is ALWAYS preferred
  // (`ig_doorbell/get_local_signal_url` -> `/api/ig_doorbell/signal/<device_id>`),
  // falling back to the old variant -talking directly to the doorbell's public hostname- only
  // if the installed integration is older and doesn't offer that command.
  //
  // WHY THE PROXY IS BETTER, and it's not an aesthetic preference: the doorbell's public hostname
  // resolves to a private LAN IP. That combination has exactly the shape of a DNS
  // rebinding attack, and iCloud Private Relay blocks it on purpose. Private Relay ships enabled
  // by default on virtually any iPhone, and the companion app is where most people open a
  // dashboard from their phone: the local path was failing precisely for the biggest group of
  // users, who ended up going out to Germany via the relay to watch a camera in their own home.
  // Home Assistant, on the other hand, is already an origin that browser has resolved and trusts.
  //
  // What does NOT go through the proxy: the MEDIA. Only a few kilobytes of SDP and ICE candidates per
  // session. Video and audio still go point-to-point over UDP against the doorbell's LAN
  // address, which is what Private Relay doesn't touch. In other words, this RESTORES the fast
  // direct path, it doesn't replace it with a slow one.
  //
  // An extra benefit worth keeping in mind: over this path the pair_app credential
  // NEVER reaches the browser's JavaScript - it stays on the integration's server side,
  // which is the one that attaches it when talking to the doorbell.
  // ==============================================================================
  async tryLocalSignaling(gen) {
    if (typeof EventSource === 'undefined') return false;

    // ⚠️ ONLY HOME ASSISTANT'S PROXY (phase 0, 2026-09-25). The direct path to the doorbell's
    // public hostname (which the browser resolved via our cloud's DNS, with the credential
    // in the URL) and the relay's WebSocket were REMOVED: Home Assistant is a local client and none of
    // it goes through the VPS. If the integration doesn't offer the proxy (a version older than 0.4.3), there's no
    // path, and it says so.
    const proxyUrl = await this._askLocalSignalUrl();
    if (this._superseded(gen)) return false;
    if (!proxyUrl) {
      this._mark('get_local_signal_url: the integration does not offer the proxy - no path (ig_doorbell >= 0.7.0 is needed)');
      return false;
    }
    this._localVia = 'proxy';
    this._localSignedUrl = proxyUrl;
    const ok = await this._openLocalSse(proxyUrl, 'proxy', gen);
    if (ok) return true;
    // SSE can't tell a 401 from a 502 (the browser doesn't expose the status code to
    // EventSource), and that difference is exactly what decides between "re-pair" and
    // "this isn't reaching the doorbell right now". It's classified with a separate request.
    await this._classifyProxyFailure();
    return false;
  }

  // `null` = this integration doesn't offer the proxy (older version) or doesn't know about this doorbell.
  // It's not an error: there's a fallback path, and announcing it as a failure would confuse debugging.
  async _askLocalSignalUrl() {
    if (!this._hass || !this._hass.connection) return null;
    try {
      const res = await this._hass.connection.sendMessagePromise({
        type: `${IG_DOMAIN}/get_local_signal_url`,
        device_id: this.config.device_id,
      });
      if (res && res.signal_url) {
        this._mark('get_local_signal_url: the integration offers a signaling proxy');
        return res.signal_url;
      }
      return null;
    } catch (err) {
      this._mark(`get_local_signal_url: not available (${err && err.code ? err.code : 'error'}) - using the doorbell's public hostname`);
      return null;
    }
  }

  // A single request, with no side effects: a `bye` signaling message with no slot is silently
  // discarded by the doorbell, so the only thing extracted here is the status CODE. The proxy passes it
  // through as-is from the doorbell (401) or sets its own (502 = Home Assistant can't reach the doorbell).
  async _classifyProxyFailure() {
    if (!this._hass || typeof this._hass.callApi !== 'function') return;
    try {
      await this._hass.callApi('POST', `${IG_DOMAIN}/signal/${this.config.device_id}`, { type: 'bye' });
    } catch (err) {
      const status = err && (err.status_code || err.status);
      if (status === 401) {
        this._reportPairingRejected('Home Assistant local proxy: 401');
      } else if (status === 502) {
        this._mark('local proxy: 502 - Home Assistant cannot reach the doorbell (powered off, or another VLAN with no route). Falling back to the relay.');
      } else {
        this._mark(`local proxy: unclassified failure (status=${status})`);
      }
    }
  }

  _openLocalSse(sseUrl, via, gen) {
    return new Promise((resolve) => {
      let settled = false;
      // ⚠️ OWN REFERENCE TO THE EventSource, IN ADDITION TO `this.nativeSSE` (2026-09-07).
      //
      // Everything inside this promise lives for up to 3 s after being created, and during that time the
      // session may have been torn down and replaced. Looking only at `this.nativeSSE` there were two
      // ways to cause harm, and both are real: closing SOMEONE ELSE's EventSource (the one from the startup
      // that superseded us, leaving the card without local signaling with nothing explaining why) and setting
      // `this.nativeSSE = null` over theirs, which is exactly how an orphaned channel gets made.
      //
      // With its own reference, each one closes its own and only releases the global slot if
      // it's still the one occupying it.
      let es = null;
      let probeTimer = null;
      const probeCtl = (typeof AbortController !== 'undefined') ? new AbortController() : null;

      const stopProbe = () => {
        if (probeTimer) { clearTimeout(probeTimer); probeTimer = null; }
        if (probeCtl) { try { probeCtl.abort(); } catch (err) { /* already finished */ } }
      };

      const finish = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        stopProbe();
        resolve(ok);
      };

      // Abandoning the local path WITHOUT leaving the slot held (2026-07-29). The doorbell assigns a slot
      // on accepting the SSE, and only considers a session abandoned with no `bye` after 20s. With
      // MAX_WEBRTC_SESSIONS=4, a handful of retries that bail out abruptly leave the user
      // with no free slots -- and that shows up as "relay failures", which is where the problem
      // would be looked for, not where it actually is. If we never got a slot there's nothing to release, and the
      // `bye` is skipped.
      const abandonLocal = () => {
        if (!es) return;
        if (this.nativeSSE !== es) {
          // We've already been superseded: the teardown that bumped the generation closed this channel and said
          // goodbye through it. Closing it again is harmless; sending `bye` would NOT be, because it would go out
          // over the live session's path with the live session's slot. It just closes, period.
          try { es.close(); } catch (err) { /* already closed */ }
          return;
        }
        if (this._slot !== null) {
          try { this.sendNativeSignal({ type: 'bye' }); } catch (err) { /* best effort */ }
        }
        es.close();
        this.nativeSSE = null;
      };

      const timeout = setTimeout(() => {
        this._mark(`tryLocalSignaling(${via}): 3000ms timeout expired with no offer`);
        abandonLocal();
        finish(false);
      }, 3000);

      // Last guard before opening anything. If we got superseded between the `await` above and here,
      // opening the SSE would spend one of the doorbell's four slots on a session nobody
      // will ever use -- and the doorbell only reclaims it on its own after 20 s.
      if (this._superseded(gen)) {
        this._mark(`tryLocalSignaling(${via}): superseded before opening the SSE - no doorbell slot spent`);
        finish(false);
        return;
      }

      this._mark(`tryLocalSignaling(${via}): opening EventSource`);
      try {
        es = new EventSource(sseUrl);
        this.nativeSSE = es;
      } catch (err) {
        clearTimeout(timeout);
        console.warn('[ig-doorbell-card] could not open local EventSource, falling back to the remote relay:', err);
        this._mark('tryLocalSignaling: EventSource lanzo excepcion al crearse');
        resolve(false);
        return;
      }

      // There's no reliable way to tell from JS "blocked by CORS" apart from "network unreachable"
      // or "some other network failure" - EventSource.onerror (just like fetch()) doesn't expose the real reason
      // by browser design, not even when the cause is CORS.
      //
      // UPDATED 2026-07-26: this notice's previous text said the doorbell "doesn't send
      // Access-Control-Allow-Origin on :8443" and pointed to CORS as the most likely cause. That
      // stopped being true on 2026-07-10 - the firmware sends `Access-Control-Allow-Origin: *` on
      // every response from /webrtc/signal and /webrtc/signal/post (401s included) and answers the
      // OPTIONS preflight with Allow-Methods GET/POST/OPTIONS + Allow-Headers Content-Type (which
      // is exactly what the signaling POST needs, since it goes with Content-Type:
      // application/json and is therefore NOT a "simple" request). Verified by reading the
      // real firmware, not assumed. Keeping the old diagnosis here would send whoever debugs
      // this in the future straight to a false lead - today the realistic causes are different.
      es.onerror = () => {
        if (this._superseded(gen)) { abandonLocal(); finish(false); return; }
        abandonLocal();
        console.warn(
          '[ig-doorbell-card] signaling through Home Assistant\'s proxy failed. ' +
          'The browser does NOT expose the status code to EventSource, so it is classified separately (see _classifyProxyFailure): ' +
          'a 401 means the pairing credential was rejected, a 502 means Home Assistant cannot reach the doorbell over the LAN.'
        );
        finish(false);
      };

      es.onmessage = (ev) => {
        // A message arriving over a superseded session's channel isn't a life signal for
        // anything, and handleNativeSignal() would apply it to the CURRENT startup's `pc` -- an
        // offer from another negotiation mixed into the good one.
        if (this._superseded(gen)) { abandonLocal(); finish(false); return; }
        let msg;
        try { msg = JSON.parse(ev.data); } catch (err) { return; }
        // Any message (including the heartbeat) is a real life signal for the signaling
        // channel - life watchdog, see COORDINATION.md Q19.
        this._recordLifeSignal();
        if (msg.type === 'heartbeat') return;
        if (msg.type === 'offer') {
          this._mark('tryLocalSignaling: offer received via SSE');
          finish(true);
        }
        this.handleNativeSignal(msg);
      };
    });
  }

  sendNativeSignal(msg) {
    const payload = Object.assign({}, msg);
    if (!this.nativeSSE) return;
    // (1.10.0) A destroyed instance talks to NO doorbell at all: an in-flight callback (a
    // talk_request, a quality...) would send the old doorbell something nobody asked for anymore. The `bye`
    // from teardown goes out before the marker is set, see _destroy().
    if (this._destroyed) return;
    // The "slot" received in the offer is mandatory on every outgoing message (§1.4/§3.3).
    if (this._slot !== null) payload.slot = this._slot;
    else if (msg.type !== 'bye') {
      // The firmware SILENTLY DISCARDS any local signaling POST with no valid "slot".
      console.warn(`[ig-doorbell-card] local message "${msg.type}" sent with no slot assigned yet - the device will discard it`);
    }
    // Over the proxy the request is authenticated just like any frontend call to its own
    // Home Assistant (callApi sets the Authorization header). The pairing credential is
    // added by the integration on the server: it never passes through this browser.
    this._hass.callApi('POST', `${IG_DOMAIN}/signal/${this.config.device_id}`, payload)
      .catch((err) => {
        const status = err && (err.status_code || err.status);
        if (status === 401) this._reportPairingRejected('Home Assistant local proxy: 401 while sending signaling');
        console.warn('[ig-doorbell-card] failed sending local signal via the Home Assistant proxy', err);
      });
  }

  async handleNativeSignal(msg) {
    // The own slot is learned ONLY from 'offer' and 'session_info' (2026-07-26). Every message from the
    // device carries `slot`, but learning it from any of them would be dangerous over the
    // REMOTE path: the relay fans out to every client on the same device_id, so a
    // message meant for someone else would overwrite our own slot, and from then on we'd misread
    // `talker` (believing we own someone else's turn, or the other way around). These two messages ARE
    // unambiguously "for me": the offer opens our session and session_info is the
    // per-recipient resynchronizer.
    if ((msg.type === 'offer' || msg.type === 'session_info') && typeof msg.slot === 'number') {
      this._slot = msg.slot;
    }

    switch (msg.type) {
      case 'offer':
        this._mark('handleNativeSignal(offer): processing SDP offer');
        await this.pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this.sendNativeSignal({ type: 'answer', sdp: answer.sdp });
        this._mark('handleNativeSignal(offer): SDP answer sent (ICE/DTLS starts now)');
        // Quality probe as soon as a slot is assigned (no need to wait for ICE/DTLS to
        // finish: the device assigns the slot when processing the connection/request_offer, and the
        // signaling channel is already alive - it's the same criterion the contract documents
        // for the 'open' message). See _probeQualitySupport().
        this._probeQualitySupport();
        // Real diagnostics (2026-07-11, see COORDINATION.md - investigating a silent audio
        // backchannel reported by the user, confirmed exclusive to this card: the web dashboard and
        // apps DO work bidirectionally). With no access to a real browser in this session, this logs to
        // the console EXACTLY which direction ended up negotiated for audio right
        // after applying the answer - before the user ever touches the mic button. If this already
        // comes out different from 'sendrecv' here, the problem is in the SDP negotiation, not in
        // toggleTalk()/replaceTrack() (further below, with its own log).
        if (this.audioTransceiver) {
          console.log(
            '[ig-doorbell-card DIAG audio] after setLocalDescription(answer): ' +
            `audioTransceiver.direction=${this.audioTransceiver.direction} ` +
            `currentDirection=${this.audioTransceiver.currentDirection} ` +
            `mid=${this.audioTransceiver.mid} ` +
            `sender.track=${this.audioTransceiver.sender && this.audioTransceiver.sender.track ? this.audioTransceiver.sender.track.id : 'null'}`
          );
          const audioLine = (answer.sdp.split('\r\n').find((l) => l.startsWith('m=audio')) || '') + ' | ' +
            (answer.sdp.split('\r\n').find((l) => l.startsWith('a=sendrecv') || l.startsWith('a=sendonly') || l.startsWith('a=recvonly') || l.startsWith('a=inactive')) || '(no global direction attribute - check per m-section)');
          console.log(`[ig-doorbell-card DIAG audio] answer SDP (m=audio line + first direction attribute found): ${audioLine}`);
        }
        break;
      case 'candidate':
        if (msg.candidate && this.pc.remoteDescription) {
          try {
            await this.pc.addIceCandidate({ candidate: msg.candidate, sdpMid: '0', sdpMLineIndex: 0 });
          } catch (err) { /* discardable candidate, non-blocking */ }
        }
        break;
      case 'open_result':
        this.handleNativeOpenResult(msg);
        break;
      case 'live_state':
        this._onLiveState(msg);
        break;
      // ---- Multi-client / quality (API_CONTRACT.md §1.4-ter, 2026-07-26) --------------------
      case 'talk_granted':
        this._handleTalkGranted(msg);
        break;
      case 'talk_denied':
        this._handleTalkDenied(msg);
        break;
      case 'talk_state':
        if (typeof msg.talker === 'number') this._talkerSlot = msg.talker;
        this._reconcileTalkTurn();
        break;
      case 'session_info':
        this._handleSessionInfo(msg);
        break;
      case 'quality_state':
        this._handleQualityState(msg);
        break;
      case 'error':
        console.warn('[ig-doorbell-card] native signaling error:', msg.reason);
        if (msg.reason === 'sessions_full' && this.badge) this._setLiveState('error_cam');
        break;
      case 'bye':
        // The device closed the session (e.g. displaced by another one) - it reconnects
        // automatically instead of leaving the card dead until the user manually reloads
        // (2026-07-10, see COORDINATION.md Q19 - same mechanism as the rest of the watchdog).
        this._scheduleReconnect('bye received from the device');
        break;
      default:
        break;
    }
  }

  triggerNativeOpen() {
    if (!this.unlockButton) return;
    this.sendNativeSignal({ type: 'open' });
    this._paintDoorOpening();
    // 6s: `open` travels over the same signaling channel as the offer, which in the worst real
    // case measured (remote path, via the relay) takes ~2.5s one-way. Twice that long, so as not
    // to blame a network that's simply slow for a failure.
    if (this._doorWaitTimer) clearTimeout(this._doorWaitTimer);
    // 10 s and not 6 (1.10.0): with the lock on Home Assistant (door_m=1) the doorbell does NOT reply
    // `open_result` instantly, but once HA confirms -- "up to ~8 s", and the contract requires
    // waiting that margin (API_CONTRACT.md §3.3, open_result row). With 6 s the card said "the door
    // has NOT opened" while it was opening. This matters more now that `unlock_entity` is gone and every
    // opening goes through here.
    this._doorWaitTimer = setTimeout(() => this._doorOpenNoAnswer(), 10000);
  }

  // ==============================================================================
  // NOTHING HAPPENS IN SILENCE (API_CONTRACT.md §1.0) - opening the door
  //
  // This fixes A LIE, not just a gap: on tapping, the card painted the button green and the
  // label "Open" BEFORE the doorbell had answered anything. If `open_result` never
  // arrived -- bad network, dropped session, a relay that doesn't respond -- the user was left staring at a
  // button that said "Open" with the door closed. On a video doorbell that's not a UI
  // detail: it's someone walking away from the door believing they opened it.
  //
  // Now there are three states and none jumps ahead of the next: OPENING (it's been sent), OPEN
  // (the doorbell confirmed it) and NO RESPONSE (the deadline ran out). A timeout is a
  // timeout, never an "open" (§1.8).
  // ==============================================================================
  _paintDoorOpening() {
    if (!this.unlockButton) return;
    this.unlockButton.classList.add('opening');
    this.unlockButton.classList.remove('active-unlock');
    if (this.unlockIcon) this.unlockIcon.setAttribute('icon', 'mdi:loading');
    if (this.unlockLabel) {
      this.unlockLabel.textContent = getLocalText(this._hass, 'lbl_door_opening');
      this.unlockLabel.classList.remove('on-green');
      this.unlockLabel.classList.add('on-amber');
    }
    // 8s of notice, longer than the 6s deadline: the message can't disappear BEFORE it's known
    // how things turned out, or the user is left with no answer at all to what they just tapped.
    this._flashStatusLine('door_opening', 8000);
  }

  _clearDoorWait() {
    if (this._doorWaitTimer) { clearTimeout(this._doorWaitTimer); this._doorWaitTimer = null; }
    if (this.unlockButton) this.unlockButton.classList.remove('opening');
    if (this.unlockLabel) this.unlockLabel.classList.remove('on-amber');
  }

  _doorOpenNoAnswer() {
    this._clearDoorWait();
    if (this.unlockIcon) this.unlockIcon.setAttribute('icon', 'mdi:lock-open-variant');
    this._setDoorLabel(false);
    console.warn('[ig-doorbell-card] no open_result arrived within 10s - NOT asserting that the door has opened');
    this._flashStatusLine('door_no_answer', 6000);
  }

  handleNativeOpenResult(msg) {
    this._clearDoorWait();
    if (!this.unlockButton) return;
    // (1.10.0) No `unlock_duration` option: the doorbell doesn't say how long its pulse lasts (`dur` lives in
    // get_states, which the card doesn't read), and the apps also render a fixed countdown. Purely decorative.
    const duration = DOOR_OPEN_DISPLAY_S;
    if (msg.status === 'opened') {
      // If the doorbell opens, it DOES have a lock: whatever was learned by failing is forgotten
      // (only applies against older firmware, see _applyDoorAvailability).
      if (this._noLockLegacy) { this._noLockLegacy = false; this._applyDoorAvailability(); }
      // NOW yes: confirmed by the doorbell, not before.
      this.unlockButton.classList.add('active-unlock');
      this.unlockIcon.setAttribute('icon', 'mdi:door-open');
      this._setDoorLabel(true);
      this._startDoorCountdown(duration);
      setTimeout(() => {
        this.unlockButton.classList.remove('active-unlock');
        this.unlockIcon.setAttribute('icon', 'mdi:lock-open-variant');
        this._setDoorLabel(false);
      }, duration * 1000);
    } else {
      this.unlockButton.classList.remove('active-unlock');
      this.unlockIcon.setAttribute('icon', 'mdi:lock-open-variant');
      this._setDoorLabel(false);
      console.warn('[ig-doorbell-card] could not open the door:', msg.error);
      if (msg.error === 'no_lock_configured') {
        this._flashStatusLine('no_lock', 3000);
        // Safety net for firmware predating `door_m` traveling in session_info: if
        // that data has already arrived, this changes nothing (the data wins) and the button shouldn't
        // have even been offered. This particular notice DOES get shown: the user just
        // tapped and deserves to know why nothing is happening.
        this._noLockLegacy = true;
        this._applyDoorAvailability();
      }
    }
  }

  // Entry point for the mic button. Since 2026-07-26 it does NOT open the mic directly: it
  // requests the talk turn first (§1.4-ter) and only calls _startTalk() on receiving talk_granted - or
  // after confirming this doorbell doesn't arbitrate turns (older firmware). See _requestTalkTurn().
  async toggleTalk() {
    if (this._talkPending) return; // a request is already in flight, don't queue another
    if (this.talkActive || this._listenOnly) {
      await this._stopTalk();
      return;
    }
    this._requestTalkTurn();
  }

  async _startTalk() {
    this.talkActive = true;
    this._listenOnly = false;
    {
      try {
        // Talking implies hearing, obviously. The sound's previous state is remembered so it can be
        // restored when the mic closes: if you were only watching in silence, you'll keep watching in
        // silence (§1.10); if you were already listening, you'll keep listening.
        this._audioOnBeforeMic = this._audioOn;
        this._setAudioOn(true, 'mic');
        console.log('[ig-doorbell-card DIAG audio] toggleIntercom: requesting getUserMedia({audio:true})...');
        const genMic = this._connGen;
        const probeStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        // ⚠️ (1.10.0) The mic permission can take as long as the user takes to answer the
        // browser prompt, and meanwhile the session may have been torn down (reconnection) or the doorbell
        // may have CHANGED. Without this check, the mic would open on a dead instance: the
        // system icon lit up and nobody listening -- or, worse, the old doorbell's turn.
        if (this._destroyed || genMic !== this._connGen) {
          probeStream.getTracks().forEach((t) => t.stop());
          console.info('[ig-doorbell-card] getUserMedia resolved after a session/doorbell change: mic released unused');
          return;
        }
        this.localAudioStream = probeStream;
        const realAudioTrack = this.localAudioStream.getAudioTracks()[0];
        console.log(
          '[ig-doorbell-card DIAG audio] getUserMedia OK: ' +
          `track.id=${realAudioTrack.id} label="${realAudioTrack.label}" ` +
          `readyState=${realAudioTrack.readyState} enabled=${realAudioTrack.enabled} muted=${realAudioTrack.muted}`
        );
        if (this.audioTransceiver && this.audioTransceiver.sender) {
          const senderBefore = this.audioTransceiver.sender.track;
          console.log(`[ig-doorbell-card DIAG audio] replaceTrack: sender.track BEFORE=${senderBefore ? senderBefore.id : 'null'} (should be the muted track ${this.dummyAudioTrack ? this.dummyAudioTrack.id : '?'})`);
          await this.audioTransceiver.sender.replaceTrack(realAudioTrack);
          const senderAfter = this.audioTransceiver.sender.track;
          console.log(
            `[ig-doorbell-card DIAG audio] replaceTrack OK: sender.track AFTER=${senderAfter ? senderAfter.id : 'null'} ` +
            `(matches the real track=${senderAfter === realAudioTrack}) ` +
            `direction=${this.audioTransceiver.direction} currentDirection=${this.audioTransceiver.currentDirection}`
          );
          // A real, known WebRTC gotcha, cheap to check: if encodings[0].active is
          // false, the browser does NOT send RTP for that encoding no matter what happens with the track/
          // direction - even if nothing above failed. This shouldn't happen here (setParameters() is
          // never called anywhere in this file), but confirming it with real data instead
          // of assuming it.
          try {
            const params = this.audioTransceiver.sender.getParameters();
            console.log(`[ig-doorbell-card DIAG audio] sender.getParameters().encodings=${JSON.stringify(params.encodings)}`);
          } catch (paramsErr) {
            console.warn('[ig-doorbell-card DIAG audio] sender.getParameters() failed', paramsErr);
          }
        } else {
          console.warn('[ig-doorbell-card DIAG audio] replaceTrack SKIPPED: audioTransceiver/sender does not exist at this moment - the mic NEVER actually activated even though the UI is going to say it did');
        }
        this._startAudioSendDiagnostics();

        this._setLiveState('open');
        if (this.audioPill) this.audioPill.style.display = 'flex';
        this._paintMicState();
        this._updateMotionPill(); // rule: never visible with the mic active
      } catch (err) {
        console.warn('[ig-doorbell-card] could not activate the microphone', err);
        this.talkActive = false;
        this.videoEl.muted = true;
        // Releasing the turn the device had just granted us: holding on to the reserved voice
        // channel without being able to use it (microphone permission denied, no capture
        // device, page served over plain HTTP...) would leave the OTHER clients unable to
        // talk until the doorbell releases it on its own after 5s. This is exactly the failure the talk
        // turn exists to avoid.
        if (this._talkHeld) {
          this.sendNativeSignal({ type: 'talk_release' });
          this._talkHeld = false;
        }
        this._paintMicState();
      }
    }
  }

  // Real closing of the microphone (hardware + sender), without touching the turn's logical state - it's
  // shared by _stopTalk() (the user turns it off) and _enterListenOnly() (the device
  // takes the turn away from us). Extracted so neither path can forget a step.
  _closeMicHardware() {
    this._stopAudioSendDiagnostics();
    if (this.localAudioStream) {
      this.localAudioStream.getTracks().forEach((track) => track.stop());
      this.localAudioStream = null;
    }
    if (this.audioTransceiver && this.audioTransceiver.sender && this.dummyAudioTrack) {
      // Goes back to the MUTED track instead of null: the transceiver must keep a live track
      // (the same muted-track+replaceTrack pattern that avoids renegotiating SDP, see
      // buildNativePeerConnection).
      try { this.audioTransceiver.sender.replaceTrack(this.dummyAudioTrack); } catch (err) { /* best effort */ }
    }
  }

  async _stopTalk() {
    // Explicitly releases the turn (§1.4-ter): without this the doorbell would keep it reserved
    // until its 5s of silence ran out, and another client wanting to talk in that gap would get an
    // unfair talk_denied. It's sent even in "listen only" mode (turn denied) in case the
    // device had granted it to us right after - it's idempotent.
    this.sendNativeSignal({ type: 'talk_release' });
    this._talkHeld = false;
    this._listenOnly = false;
    this.talkActive = false;
    this._setAudioOn(this._audioOnBeforeMic, 'mic-closed');
    this._closeMicHardware();
    this._setLiveState('live');
    if (this.audioPill) this.audioPill.style.display = 'none';
    this._paintMicState();
    this._updateMotionPill();
  }

  // ==============================================================================
  // REAL AUDIO-SEND DIAGNOSTICS (2026-07-11, see COORDINATION.md) - investigating the
  // doorbell's HASS->speaker backchannel reported as mute, confirmed EXCLUSIVE to this
  // card (the web dashboard and apps DO work bidirectionally, ruling out firmware/protocol). Probes
  // pc.getStats() of the audio sender (outbound-rtp) every 3s while the mic is active - it's the
  // ONLY way to know with certainty whether the browser is genuinely sending real bytes, instead
  // of assuming it because getUserMedia()/replaceTrack() didn't throw any exception. Remove/lower
  // the log level once the real problem is closed.
  // ==============================================================================
  _startAudioSendDiagnostics() {
    this._stopAudioSendDiagnostics();
    this._audioSendPrevBytes = null;
    this._audioSendDiagTimer = setInterval(async () => {
      if (!this.pc || !this.audioTransceiver || !this.audioTransceiver.sender) return;
      try {
        const stats = await this.audioTransceiver.sender.getStats();
        let found = false;
        stats.forEach((report) => {
          if (report.type === 'outbound-rtp' && report.kind === 'audio') {
            found = true;
            const delta = this._audioSendPrevBytes === null ? 'n/a' : (report.bytesSent - this._audioSendPrevBytes);
            console.log(
              '[ig-doorbell-card DIAG audio] outbound-rtp audio: ' +
              `bytesSent=${report.bytesSent} (+${delta} since the last 3s check) packetsSent=${report.packetsSent}`
            );
            if (this._audioSendPrevBytes !== null && report.bytesSent === this._audioSendPrevBytes) {
              console.warn('[ig-doorbell-card DIAG audio] WARNING: bytesSent has NOT increased in the last 3s - the browser is not sending real audio even though replaceTrack() did not fail. Check getUserMedia (permission/device) and the transceiver currentDirection.');
            }
            this._audioSendPrevBytes = report.bytesSent;
          }
        });
        if (!found) {
          console.warn('[ig-doorbell-card DIAG audio] WARNING: there is no outbound-rtp audio entry in getStats() - there is no active audio sender at the transport level.');
        }
      } catch (err) {
        console.warn('[ig-doorbell-card DIAG audio] audio sender getStats() failed', err);
      }
    }, 3000);
  }

  _stopAudioSendDiagnostics() {
    if (this._audioSendDiagTimer) {
      clearInterval(this._audioSendDiagTimer);
      this._audioSendDiagTimer = null;
    }
    this._audioSendPrevBytes = null;
  }

  setupRemoteStream(stream) {
    if (this.videoEl.srcObject !== stream) {
      this._mark('setupRemoteStream: pc.ontrack fired (remote stream assigned to the <video>)');
      // Real life signal + reset of the reconnection backoff - a session that gets this
      // far is considered genuinely recovered, not just "connected at the signaling level"
      // (2026-07-10, see COORDINATION.md Q19).
      this._recordLifeSignal();
      this._reconnectAttempt = 0;
      // There's VIDEO: the second place where the idle countdown is born (the other is
      // startWebRTC). And it's the one that genuinely matters, because what keeps the screen on
      // on the wallpanel isn't any wake lock of ours -- it's this <video> playing,
      // which grabs the window lock all by itself. The deadline is absolute, so rearming here on
      // every reconnection does NOT hand out extra time (v1.5.1).
      this._armIdleWakeLockTimer();
      // There's video: whatever the path, this doorbell DOES accept this credential. If there was a
      // sticky pairing-rejected notice, it's no longer true and it gets cleared.
      this._clearPairingRejected();
      // §1.0: every indicator ENDS. The retry countdown and any waiting notice get
      // cleared the instant there's an image, which is the only proof that it's over.
      this._stopRetryCountdown();
      if (this.statusLine && this.statusLine.classList.contains('warn')) this._resetStatusLine();
      this.videoEl.srcObject = stream;
      // MUTED unless the user had already deliberately opened it in this same card (§1.10):
      // a reconnection must not leave whoever was listening deaf, but it also must not turn on the
      // sound of a new session by itself.
      this.videoEl.muted = !this._audioOn;
      // The card no longer manages volume (the slider was removed, 2026-09-25): always 1, the
      // real control belongs to the device/speaker itself.
      this.videoEl.volume = 1;
      this.videoEl.play().catch(() => {});
      this._paintAudioState();

      // ⚠️ (1.10.0) 'live' IS NO LONGER DECLARED HERE. `ontrack` fires on applying the offer, BEFORE
      // a single packet arrives (ICE might never connect), and with that the live-tag said
      // "Live" -- and the doorbell selector's dot, which is the same state, turned
      // GREEN -- over a session with no image. This is exactly the apps' bug the dot must
      // not repeat. `_confirmLiveFromMedia()` sets 'live': the <video>'s 'timeupdate' (image that
      // genuinely advances, several times a second) or the getStats watchdog (packets climbing).
      this.micButton.removeAttribute('disabled');
      if (this.unlockButton) this.unlockButton.removeAttribute('disabled');

      if (this.loader) {
        this.loader.style.opacity = '0';
        setTimeout(() => this.loader.style.pointerEvents = 'none', 300);
      }

      // A more precise timestamp than 'ontrack' (above): the actual moment the browser
      // RENDERS the first decoded frame, which is what the user perceives as "there's
      // video now" - ontrack only marks when the stream arrives at the transport level, not when
      // something actually shows on screen. requestVideoFrameCallback is supported on Chrome/Edge/Safari 16+
      // (not on every browser/version) - hence the guard, with onloadeddata as a
      // reasonable fallback where it doesn't exist.
      if (typeof this.videoEl.requestVideoFrameCallback === 'function') {
        this.videoEl.requestVideoFrameCallback(() => {
          this._mark('first video frame ACTUALLY painted on screen (requestVideoFrameCallback)');
        });
      } else {
        this.videoEl.addEventListener('loadeddata', () => {
          this._mark('first video frame with data loaded (loadeddata event, fallback with no requestVideoFrameCallback)');
        }, { once: true });
      }
    }
  }

  injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      ${CARD_TAG}, ${VIEW_TAG} { display: block; width: 100%; box-sizing: border-box; }

      /* Exact palette from the Figma mockup (android_app/ios_app) - see COORDINATION.md Q22-bis
         in ig_hassio_addons. Custom properties scoped to .ig-container (not :root - this
         card does not use Shadow DOM, so :root would leak into HA's whole document). */
      .ig-container {
        /* EXACT values confirmed against the real source code of android_app/ios_app
           (2026-07-10, see COORDINATION.md Q22-bis) - not approximated from a screenshot. */
        --ig-lime:#78C800; --ig-cyan:#00C4D4; --ig-blue:#1976D2; --ig-blue-dark:#1565C0;
        --ig-bg:#070D1A; --ig-surf1:#0D1B2E; --ig-surf2:#162336; --ig-surf3:#1D2D42;
        --ig-text:#E8F0FE; --ig-muted:#94A3B8; --ig-dim:#64748B; --ig-faint:#334155;
        --ig-green:#4CAF50; --ig-red:#EF5350; --ig-amber:#FFB300; --ig-indigo:#818CF8;
        position: relative; width: 100%; box-sizing: border-box; background: var(--ig-bg);
        font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif;
        padding: 10px; display: flex; flex-direction: column; gap: 10px;
      }

      /* overflow-y:auto, NOT plain "hidden" (v1.9.5) - until now nothing added real height to the
         document: .actions-row/.status-line live INSIDE .feed-wrap as overlaid layers
         (position:absolute), so "hidden" never clipped anything real, only decorative bleed
         (pulsering, shadows). #bottom-row (Recordings) is the first piece that DOES fall outside
         the normal flow, AFTER .feed-wrap - in a "panel" dashboard with the video at its maximum
         height (measured on the real tablet: Inaki's card video fills the whole screen edge to
         edge) there is no room left below and "hidden" swallowed the whole button, with no
         possible scroll to reach it. overflow-x stays hidden (nothing grows in width). In
         fullscreen nothing changes: top-row/bottom-row are hidden entirely (see .ig-fs below) and
         the only content left (the video) already fits exactly 100% of the height. */
      ha-card { display: block; width: 100%; box-sizing: border-box; overflow: hidden auto; border-radius: var(--ha-card-border-radius, 12px); box-shadow: var(--ha-card-box-shadow, 0px 2px 4px -1px rgba(0,0,0,0.2)); background: #070D1A; }

      /* ---- header: dropdown mode chip + REC (v1.9.5, replaces the row of 4 segmented
         chips) ---- */
      .top-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      /* ---- doorbell selector (1.10.0): dot + name + chevron capsule, like DoorbellCapsule
         in the apps. Shrinks with an ellipsis before pushing REC/bell out. ---- */
      .top-left { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1 1 auto; }
      .top-left .mode-row { flex: none; }
      .db-picker { position: relative; min-width: 0; flex: 0 1 auto; }
      .db-pill {
        display: flex; align-items: center; gap: 8px; max-width: 100%; min-width: 0;
        padding: 6px 12px; border-radius: 999px; background: var(--ig-surf1);
        border: 1px solid rgba(255,255,255,0.14); color: var(--ig-text); font-family: inherit;
        font-size: 13px; font-weight: 600; cursor: default; box-sizing: border-box;
      }
      .db-pill.pickable { cursor: pointer; }
      .db-pill.pickable:hover { border-color: rgba(255,255,255,0.3); }
      .db-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
      .db-chev { --mdc-icon-size: 16px; color: var(--ig-muted); flex: none; margin-right: -4px; }
      .db-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--ig-dim); }
      /* Green ONLY with real video (live/open). Connecting: breathing amber. Error: red.
         Paused: gray. 'avail'/'down' are for OTHER doorbells' rows in the menu (HA data). */
      .db-dot[data-state="live"], .db-dot[data-state="open"] { background: var(--ig-green); box-shadow: 0 0 6px var(--ig-green); }
      .db-dot[data-state="connecting"] { background: var(--ig-amber); animation: ig-breathe 1.1s ease-in-out infinite; }
      .db-dot[data-state="error"] { background: var(--ig-red); }
      .db-dot[data-state="warn"] { background: var(--ig-dim); }
      .db-dot[data-state="avail"] { background: var(--ig-green); }
      .db-dot[data-state="down"] { background: var(--ig-red); }
      @media (prefers-reduced-motion: reduce) { .db-dot[data-state="connecting"] { animation: none; } }
      .db-menu {
        position: absolute; top: calc(100% + 4px); left: 0; z-index: 25; display: none;
        flex-direction: column; min-width: 220px; max-width: min(320px, 90vw); background: var(--ig-surf1);
        border-radius: 12px; padding: 4px; box-shadow: 0 8px 24px rgba(0,0,0,0.5); border: 1px solid rgba(255,255,255,0.08);
      }
      .db-menu-title { font-size: 11px; font-weight: 700; color: var(--ig-muted); padding: 6px 10px 4px; text-transform: uppercase; letter-spacing: 0.04em; }
      .db-opt {
        display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 8px 10px; border-radius: 8px;
        border: none; background: transparent; color: var(--ig-text); font-size: 14px; font-weight: 500;
        cursor: pointer; font-family: inherit; text-align: left;
      }
      .db-opt:hover { background: rgba(255,255,255,0.06); }
      .db-opt.sel { font-weight: 700; }
      .db-check { --mdc-icon-size: 16px; width: 16px; flex: none; color: var(--ig-lime); }
      .db-opt-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
      .mode-row { display: none; position: relative; }
      /* Same look as the apps' _ModePill: translucent dark background (never a scrim, so it
         reads over any scene if it ever lives over the video again), border and icon/label in
         the color of the CURRENT mode, dropdown arrow. No known color (an option that matches
         no _modeKeyFor pattern) falls back to --ig-dim, same as before. */
      .mode-pill {
        display: flex; align-items: center; gap: 6px; padding: 6px 10px; border-radius: 999px;
        background: rgba(7,13,26,0.82); border: 1px solid rgba(255,255,255,0.14);
        color: var(--ig-dim); font-size: 12px; font-weight: 700; cursor: pointer; font-family: inherit;
      }
      .mode-pill ha-icon { --mdc-icon-size: 14px; }
      .mode-pill .mode-pill-caret { --mdc-icon-size: 16px; margin-left: -2px; }
      .mode-pill.mode-normal { color: var(--ig-lime); border-color: rgba(120,200,0,0.45); }
      .mode-pill.mode-away { color: var(--ig-amber); border-color: rgba(255,179,0,0.45); }
      .mode-pill.mode-night { color: var(--ig-indigo); border-color: rgba(129,140,248,0.45); }
      .mode-pill.mode-custom { color: var(--ig-cyan); border-color: rgba(0,196,212,0.45); }
      /* The dropdown itself: same position:absolute; top:under as PopupMenuPosition.under
         in the app - it floats OVER whatever comes next (the video frame) instead of pushing it. */
      .mode-menu {
        position: absolute; top: calc(100% + 4px); left: 0; z-index: 20; display: none;
        flex-direction: column; min-width: 160px; background: var(--ig-surf1); border-radius: 12px;
        padding: 4px; box-shadow: 0 8px 24px rgba(0,0,0,0.5); border: 1px solid rgba(255,255,255,0.08);
      }
      .mode-menu .mode-opt {
        display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 8px;
        border: none; background: transparent; color: var(--ig-text); font-size: 13px;
        font-weight: 500; cursor: pointer; font-family: inherit; text-align: left;
      }
      .mode-menu .mode-opt ha-icon { --mdc-icon-size: 16px; }
      .mode-menu .mode-opt:hover { background: rgba(255,255,255,0.06); }
      .mode-menu .mode-opt.sel { font-weight: 700; }
      .mode-menu .mode-opt.sel.mode-normal { color: var(--ig-lime); }
      .mode-menu .mode-opt.sel.mode-away { color: var(--ig-amber); }
      .mode-menu .mode-opt.sel.mode-night { color: var(--ig-indigo); }
      .mode-menu .mode-opt.sel.mode-custom { color: var(--ig-cyan); }

      /* REC (v1.9.5): small capsule with a red dot + "REC", same look as the apps' RecButton.dart
         (StadiumBorder, surf1 background, hairline border at rest / red while recording, hollow/
         filled dot) - NO LONGER the big 60px circle it used to share with sound/door. */
      .rec-action-wrap { display: flex; align-items: center; }
      .rec-pill {
        display: flex; align-items: center; gap: 4px; height: 24px; padding: 0 8px;
        border-radius: 999px; background: var(--ig-surf1); border: 1px solid rgba(255,255,255,0.05);
        cursor: pointer; font-family: inherit;
      }
      .rec-dot {
        width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0;
        border: 1.5px solid var(--ig-red); background: transparent;
      }
      .rec-pill-label { font-size: 11px; font-weight: 700; color: var(--ig-muted); }
      .rec-pill.recording { border-color: var(--ig-red); }
      .rec-pill.recording .rec-dot {
        background: var(--ig-red); border-color: var(--ig-red);
        animation: ig-rec-blink 1.2s ease-in-out infinite;
      }
      .rec-pill.recording .rec-pill-label { color: var(--ig-red); }
      @keyframes ig-rec-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.15; } }
      /* Same criterion as _reduceMotion in RecButton.dart: no blinking if the system asks to
         reduce motion, the dot stays solid red (it is still visible that it is recording). */
      @media (prefers-reduced-motion: reduce) {
        .rec-pill.recording .rec-dot { animation: none; }
      }

      /* Recordings (v1.9.5): same look as the apps' _QuickButton (icon in a rounded box +
         label, wide row) - no "Settings": that lives in the integration. */
      /* ⚠️ NEVER "display:none" here (1.9.7). Until 1.9.6 this rule said none, and
         _updateRecordingsButton() "shows it" by removing the inline display (style.display='') -
         which falls back onto THIS rule: Recordings was NEVER visible, anywhere, and the bug was
         hunted in the card's height and in HA's wrapper. It is hidden by the inline
         style="display:none" in the markup itself until the role allows it. */
      /* v1.9.8: the same wide row as always, now with TWO buttons ("split the Recordings bar in
         two: Recordings and Quick replies, so we don't take up more space" -- Inaki,
         2026-09-25). display:flex instead of block to put them side by side; the height doesn't
         change from 1.9.7 because .quick-btn keeps its vertical padding. */
      .bottom-row { display: flex; gap: 8px; }
      .quick-btn {
        display: flex; align-items: center; gap: 9px; width: 100%; box-sizing: border-box;
        padding: 10px 12px; border-radius: 16px; background: var(--ig-surf1);
        border: 1px solid rgba(255,255,255,0.05); cursor: pointer; font-family: inherit; text-align: left;
      }
      .quick-btn:hover { background: var(--ig-surf2); }
      .quick-btn-icon {
        width: 32px; height: 32px; border-radius: 10px; flex-shrink: 0;
        display: flex; align-items: center; justify-content: center; background: rgba(25,118,210,0.14);
      }
      .quick-btn-icon ha-icon { --mdc-icon-size: 15px; color: var(--ig-blue); }
      .quick-btn-label { font-size: 12px; font-weight: 500; color: var(--ig-muted); }
      /* Each half splits the width equally -- and if the other button is hidden (non-admin
         Recordings), this one grows on its own and takes the whole row, for free, by being
         flex:1 (see _updateBottomRowVisibility()). min-width:0 is what lets the label's
         overflow/wrap work inside a flex child -- without this the text pushes the button
         instead of fitting inside it. */
      .quick-btn.half { flex: 1 1 0; min-width: 0; padding: 10px 8px; gap: 6px; }
      .quick-btn.half .quick-btn-icon { width: 28px; height: 28px; }
      /* "If they don't fit, the text should shrink or become an icon with an accessible label,
         not get cut off" (Inaki, 2026-09-25): without white-space:nowrap the label wraps to a
         second line instead of being clipped with an ellipsis -- measured with Playwright at
         375px width (the narrower of the two cases: portrait phone AND the tablet rail) that the
         two longest labels in the catalog ("Respuestas rápidas", "Schnellantworten") fit in two
         lines without overflowing the button. */
      .quick-btn.half .quick-btn-label {
        font-size: 11px; line-height: 1.15; white-space: normal; overflow-wrap: break-word;
      }

      /* ---- rounded video frame + overlaid HUD ---- */
      .feed-wrap {
        /* Container query, not a media query (2026-07-26): the HUD has to adapt to the CARD's
           width, which in Home Assistant has nothing to do with the window's width - a narrow
           card in a column of a wide desktop dashboard is a normal case, and a @media would have
           treated it as a "big screen". See the @container rules below. */
        container-type: inline-size; container-name: igfeed;
        position: relative; width: 100%; border-radius: 22px; overflow: hidden;
        border: 1px solid rgba(255,255,255,0.06);
        background: radial-gradient(ellipse at 30% 20%, rgba(60,80,110,0.35), transparent 60%),
                    linear-gradient(180deg, #1b2536 0%, #0d1420 55%, #070a12 100%);
      }
      .video-wrapper { position: absolute; top: 0; left: 0; width: 100%; height: 100%; transform-origin: 0 0; }
      /* Pinch-to-zoom (1.9.3): the transform and touch-action are written by _zPaint() (see the
         ⚠️ in _setupZoom); here only the starting value. */
      .feed-wrap { touch-action: pan-x pan-y; -webkit-user-select: none; user-select: none; }
      .feed-wrap.ig-zoomed { cursor: grab; }
      .video-wrapper video { width: 100%; height: 100%; object-fit: contain; }

      /* pointer-events:none from the start (2026-07-29). The loading scrim covers the whole
         frame with z-index 10 and until now only stopped intercepting clicks when the first
         frame arrived (inline, from setupRemoteStream). Real effect: while the card was
         connecting - which with the doorbell off or from outside home can take quite a while -
         no HUD control responded, including the fullscreen button; and after a reconnect the
         scrim went back to opacity 1 but WITHOUT going back to intercepting, so the behavior
         wasn't even consistent with itself. The scrim has nothing that can be pressed: it is
         decoration, and decoration must not steal clicks. */
      .ig-loader-overlay { position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: rgba(7,10,18,0.85); z-index: 10; display: flex; align-items: center; justify-content: center; transition: opacity 0.3s ease; pointer-events: none; }
      .ig-ring { position: absolute; width: 60px; height: 60px; border: 4px solid rgba(0,196,212,0.2); border-top-color: var(--ig-cyan); border-radius: 50%; animation: ig-spin 1s linear infinite; }
      .ig-logo { position: absolute; color: #fff; font-family: system-ui, sans-serif; font-weight: 800; font-size: 16px; letter-spacing: 1px; }
      @keyframes ig-spin { 100% { transform: rotate(360deg); } }

      .hud-top { position: absolute; top: 12px; left: 14px; right: 14px; display: flex; align-items: flex-start; justify-content: space-between; z-index: 5; pointer-events: none; }
      .hud-top-left { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

      /* WebRTC client counter (§1.4-ter #2). Discreet when you are alone (the normal case),
         highlighted in cyan only when there is MORE than one - which is the data point that
         changes how you behave ("someone else is watching/can talk"). */
      .clients-pill {
        display: flex; align-items: center; gap: 4px; pointer-events: auto;
        background: rgba(7,13,26,0.72); backdrop-filter: blur(6px);
        border: 1px solid rgba(255,255,255,0.12); border-radius: 999px; padding: 4px 9px;
        font-size: 10.5px; font-weight: 700; color: var(--ig-muted); font-variant-numeric: tabular-nums;
      }
      .clients-pill ha-icon { --mdc-icon-size: 13px; }
      .clients-pill.multi { color: var(--ig-cyan); border-color: rgba(0,196,212,0.45); background: rgba(0,196,212,0.16); }

      .live-tag {
        display: flex; align-items: center; gap: 6px; pointer-events: auto;
      }
      .live-tag .reddot { width: 7px; height: 7px; border-radius: 50%; background: var(--ig-cyan); box-shadow: 0 0 8px var(--ig-cyan); flex-shrink: 0; }
      .live-tag[data-state="live"] .reddot, .live-tag[data-state="open"] .reddot { background: var(--ig-red); box-shadow: 0 0 8px var(--ig-red); animation: ig-pulse 1.4s infinite; }
      .live-tag[data-state="error"] .reddot { background: var(--ig-red); box-shadow: 0 0 8px var(--ig-red); }
      .live-tag[data-state="warn"] .reddot { background: var(--ig-amber); box-shadow: 0 0 8px var(--ig-amber); }
      @keyframes ig-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
      .status-badge {
        background: rgba(7,13,26,0.72); backdrop-filter: blur(6px); color: var(--ig-text);
        padding: 5px 10px; border-radius: 999px; font-size: 10.5px; font-weight: 700;
        letter-spacing: 0.04em; border: 1px solid rgba(255,255,255,0.12);
        font-family: inherit; transition: all 0.3s ease;
      }

      .hud-bottom-right { display: flex; align-items: center; gap: 6px; margin-left: auto; }

      /* Fullscreen button, last item of the right cluster. */
      .hud-fs {
        display: flex; align-items: center; justify-content: center; cursor: pointer;
        background: rgba(7,13,26,0.55); border: 1px solid rgba(255,255,255,0.12);
        border-radius: 999px; padding: 5px; color: var(--ig-text); pointer-events: auto;
        font-family: inherit;
      }
      .hud-fs ha-icon { --mdc-icon-size: 18px; }
      .hud-fs:hover { border-color: rgba(0,196,212,0.5); }
      .hud-fs.on { color: var(--ig-cyan); border-color: rgba(0,196,212,0.5); }

      /* Signal bars, bottom-right corner (mockup) - reflect the real connection state
         (data-state, also propagated to .feed-wrap from _setLiveState()) instead of a WiFi
         metric this card has no way to know - an honest adaptation of the element, not a
         literal imitation of a data point that doesn't exist here. */

      .motion-pill {
        position: absolute; top: 44px; left: 50%; transform: translateX(-50%); z-index: 6;
        display: flex; align-items: center; gap: 5px; background: rgba(255,179,0,0.92);
        border-radius: 999px; padding: 5px 11px;
      }
      .motion-pill ha-icon { --mdc-icon-size: 13px; color: #1a1300; }
      .motion-pill span { font-size: 10.5px; font-weight: 700; color: #1a1300; }

      /* justify-content:flex-start (not space-between) on purpose: audio-pill is hidden most of
         the time (only with the mic active) - with space-between and a single visible child,
         that child would stick to the LEFT (real flexbox behavior with 1 item), not to the
         right, where the volume+signal cluster must always be. margin-left:auto on
         .hud-bottom-right pushes it to the right edge robustly no matter what happens with
         audio-pill. */
      .hud-bottom { position: absolute; bottom: 12px; left: 14px; right: 14px; display: flex; align-items: center; justify-content: flex-start; gap: 8px; z-index: 5; flex-wrap: wrap; }
      .audio-pill {
        display: flex; align-items: center; gap: 6px; background: rgba(0,196,212,0.18);
        border: 1px solid rgba(0,196,212,0.4); border-radius: 999px; padding: 5px 10px;
      }
      .audio-pill ha-icon { --mdc-icon-size: 13px; color: #bdf3f8; }
      .audio-pill span { font-size: 10px; font-weight: 600; color: #bdf3f8; }

      /* ---- HUD on narrow cards (portrait phone, or a narrow desktop column) ----
         The bottom-right cluster went from 2 pieces (volume + signal) to 3 when the quality
         selector was added, and with the "Audio active" pill on the left everything no longer
         fits in ~360px. Eviction priority: first the signal bars (decorative, their information
         is already in the live-tag above), then the volume slider shrinks, and as a last resort
         the quality selector is left with just its icon. Nothing is hidden if it is the only way
         to reach a feature. */

      /* ---- status line + action buttons: OVER the video, not below it ----
         Inaki, 2026-09-07: "for a universal solution that works on any device, it's better for
         the card to put those buttons INSIDE the video image itself, at the bottom". Measured on
         the real wallpanel (Galaxy Tab in landscape): with the buttons below the video frame they
         ended up cut off below the fold and opening the door needed scrolling - a wall panel
         should not need scrolling for that. This is the SAME design fullscreen already solved
         (gradient scrim + floating controls below), brought to normal mode instead of
         reinvented - the only real difference is that here the video frame can be small, so the
         scrim is percentage-based and not in fixed pixels like fullscreen's (which always fills
         the whole screen). */
      .status-line {
        position: absolute; left: 0; right: 0; bottom: 122px; z-index: 7;
        font-size: 12px; text-align: center; font-weight: 500; pointer-events: none;
        color: rgba(232,240,254,0.85); text-shadow: 0 1px 4px rgba(0,0,0,0.85);
      }
      .status-line.open { color: var(--ig-green); font-weight: 600; }
      .status-line.warn { color: var(--ig-amber); font-weight: 600; }

      /* Readability scrim under the floating controls - same reason as in fullscreen
         (see below): over a doorway at noon light text becomes illegible, and here you need to
         read "Door open" or "channel busy". Contained by .feed-wrap's overflow:hidden and
         border-radius, so it doesn't spill out of the rounded frame. */
      .feed-wrap::after {
        content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 46%; z-index: 4;
        background: linear-gradient(180deg, transparent, rgba(0,0,0,0.5) 55%, rgba(0,0,0,0.72));
        pointer-events: none;
      }

      /* ---- asymmetric action buttons: mic is the star, door is secondary ----
         position:absolute + pointer-events:none on the row and :auto on each action, same
         criterion as fullscreen: the row must not steal clicks from the video in the area where
         there is no button, only the circles themselves. */
      .actions-row {
        position: absolute; left: 0; right: 0; bottom: 10px; z-index: 8;
        display: flex; justify-content: center; align-items: flex-end; gap: 16px;
        padding: 0; pointer-events: none; flex-wrap: nowrap;
      }
      .actions-row .action { pointer-events: auto; }
      .action { display: flex; flex-direction: column; align-items: center; gap: 6px; }
      .action .btn {
        border-radius: 50%; border: 2px solid rgba(255,255,255,0.08); cursor: pointer;
        display: flex; align-items: center; justify-content: center; position: relative;
        /* Translucent + blur (not the solid surf2/surf3 from before): the button now lives OVER
           the video in any scene, not over the card's fixed dark background. */
        background: linear-gradient(135deg, rgba(22,35,54,0.92), rgba(29,45,66,0.92));
        backdrop-filter: blur(6px);
        box-shadow: 0 6px 22px rgba(0,0,0,0.65); color: var(--ig-muted); transition: all 0.3s ease;
      }
      .action .btn:disabled { opacity: 0.5; cursor: not-allowed; }
      /* 80px/60px EXACT, confirmed against the real source code (2026-07-10, before 76/56
         approximated from the visual reconstruction) - see COORDINATION.md Q22-bis. Sound joined
         the row (2026-09-25 morning) with the same "secondary" size as the door; REC lived here
         for a few hours that same day and moved to the header that same afternoon (see .rec-pill
         above) - "the look is very different from the apps'" compared to the real app. */
      .action .btn.mic { width: 80px; height: 80px; }
      .action .btn.mic ha-icon { --mdc-icon-size: 30px; }
      .action .btn.door, .action .btn.snd { width: 60px; height: 60px; }
      .action .btn.door ha-icon, .action .btn.snd ha-icon { --mdc-icon-size: 24px; }
      .action .btn.active-talk { background: linear-gradient(135deg, var(--ig-cyan), var(--ig-blue)); border-color: transparent; box-shadow: 0 0 28px rgba(0,196,212,0.45), 0 8px 24px rgba(0,0,0,0.4); color: var(--ig-text); transform: scale(1.05); }
      .action .btn.active-unlock { background: linear-gradient(135deg, var(--ig-green), #388E3C); border-color: transparent; box-shadow: 0 0 22px rgba(76,175,80,0.5); color: var(--ig-text); transform: scale(1.05); }
      /* Street speaker (§1.10): same visual criterion as the rest - dull gray at rest
         (muted), cyan when it's really audible. Replaces the old small backgroundless HUD
         button (.snd-btn), which used to live next to the now-removed volume slider. */
      .action .btn.snd.on { color: var(--ig-cyan); border-color: rgba(0,196,212,0.5); box-shadow: 0 0 18px rgba(0,196,212,0.35), 0 6px 22px rgba(0,0,0,0.65); }
      .pulsering { position: absolute; inset: 0; border-radius: 50%; border: 2px solid var(--ig-cyan); animation: ig-ring 1.2s infinite; pointer-events: none; display: none; }
      .action .btn.active-talk .pulsering { display: block; }
      @keyframes ig-ring { 0% { transform: scale(1); opacity: 0.55; } 100% { transform: scale(1.55); opacity: 0; } }
      /* Light labels + shadow, not the dull gray from before: they have to read over ANY
         video background, just as fullscreen already solved. */
      .action .lbl { font-size: 12px; font-weight: 500; color: rgba(232,240,254,0.9); text-shadow: 0 1px 4px rgba(0,0,0,0.8); }
      .action .lbl.on-cyan { color: var(--ig-cyan); }
      .action .lbl.on-green { color: var(--ig-green); }
      .action .lbl.on-amber { color: var(--ig-amber); }

      /* ---- bottom-right HUD (volume/quality/fullscreen): must not overlap the action buttons
         or the status line, which now float over the video. With a wide frame there is plenty
         of room to the right of the centered buttons; below ~520px of video width (a portrait
         phone, or the rail does NOT apply because the video isn't vertical-inside-a-landscape-
         frame) the cluster no longer fits alongside and moves above the whole stack
         (button+label+status line). Same threshold as fullscreen (see below), and measured the
         same way: it has to be tested, not calculated from memory. */
      @container igfeed (max-width: 520px) {
        .hud-bottom { bottom: 148px; }
      }

      /* With sound added to the row (2026-09-25) the three buttons don't fit at their normal size
         on a narrow card (portrait phone, or a narrow column of a desktop dashboard)
         - they shrink one step instead of overflowing or wrapping the row, which would break the
         fixed layout the contract asks for (sound, mic, unlock, in that order and on a single
         line; REC no longer lives here, see .rec-pill). */
      @container igfeed (max-width: 380px) {
        .actions-row { gap: 8px; }
        .action .btn.mic { width: 68px; height: 68px; }
        .action .btn.mic ha-icon { --mdc-icon-size: 26px; }
        .action .btn.door, .action .btn.snd { width: 52px; height: 52px; }
        .action .btn.door ha-icon, .action .btn.snd ha-icon { --mdc-icon-size: 21px; }
      }
      @container igfeed (max-width: 300px) {
        .action .lbl { display: none; }
      }

      /* ---- mic button states introduced by the talk turn (§1.4-ter #1) ----
         The three are visually DISTINCT from each other and from "talking" (cyan): requesting
         turn (pulsing amber), listen-only (fixed amber, turn denied but the doorbell can be
         heard) and busy with another (faint amber outline, without looking disabled - it can
         still be pressed, and the doorbell replies with an explicit talk_denied). */
      .action .btn.requesting { border-color: var(--ig-amber); color: var(--ig-amber); animation: ig-breathe 1.1s ease-in-out infinite; }
      .action .btn.listen-only { background: linear-gradient(135deg, var(--ig-surf3), #2a3a52); border-color: var(--ig-amber); color: var(--ig-amber); }
      .action .btn.busy-other { border-color: rgba(255,179,0,0.45); color: rgba(255,179,0,0.8); }
      @keyframes ig-breathe { 0%,100% { opacity: 1; } 50% { opacity: 0.55; } }

      /* ---- unlock confirmation (§1.8): ARMED state of the door button ----
         Amber, not green: green means "open" and this hasn't opened anything yet. The shrinking
         ring is the 3-second countdown - the contract asks for it "if feasible", and here it's
         feasible with no JS timer at all. Without it, an armed button looks the same in the
         first second as in the third, and the user doesn't know whether pressing it still
         counts. */
      .action .btn.confirming {
        border-color: var(--ig-amber); color: var(--ig-amber);
        background: linear-gradient(135deg, rgba(255,179,0,0.18), rgba(255,179,0,0.06));
        box-shadow: 0 0 22px rgba(255,179,0,0.35);
      }
      .action .btn.confirming::after {
        content: ''; position: absolute; inset: -4px; border-radius: 50%;
        border: 2px solid var(--ig-amber); animation: ig-armed 3s linear forwards;
        pointer-events: none;
      }
      @keyframes ig-armed { 0% { transform: scale(1.25); opacity: 0.9; } 100% { transform: scale(1); opacity: 0; } }

      /* ---- OPENING state (§1.0): the unlock message has been sent and a reply is awaited --
         Visually distinct from the green of "open", which is the confirmation that cannot be
         assumed ahead of time. The icon spins while it lasts: an action that takes a while has
         to look in progress from the very first instant, and this state ALWAYS ends - either
         open_result arrives, or the 6s deadline is hit and it says there was no reply. */
      .action .btn.opening { border-color: var(--ig-amber); color: var(--ig-amber); }
      .action .btn.opening ha-icon { animation: ig-spin 1s linear infinite; }

      /* ==========================================================================
         FULLSCREEN. A SINGLE set of rules for both levels
         (native API and our own fallback), governed by the [data-fs] attribute - see
         _applyFullscreenUI(). The only difference between levels is the .ig-fs-pseudo block
         further below: in native fullscreen it's the browser that positions the element.

         The !important on .feed-wrap is not a shortcut: the video frame's height/aspect ratio
         are set as an INLINE style from render() (the card's 'height' option), and an inline
         style beats any normal rule in this sheet. This is exactly the case !important exists
         for, not a made-up specificity fight.
         ========================================================================== */
      ${VIEW_TAG}[data-fs] { height: 100%; background: #000; }
      /* Safety net for NATIVE fullscreen (2026-09-25, see the why measured in
         _applyFullscreenUI()): forces the same explicit position:fixed + inset:0 that the CSS
         fallback already gave itself, instead of trusting the browser's UA sheet to lay out
         :fullscreen full-screen on its own - in at least one real WebView (the Home Assistant
         Android app) it wasn't enough, and the symptom was a stable ~210px black strip at the
         bottom with the system status/nav bars already hidden (i.e. the gap is INSIDE the web
         content, it isn't the OS's). Never triggered on the fallback (.ig-fs-pseudo), which
         doesn't need this and must not be touched. */
      ${VIEW_TAG}.ig-fs-native-layout {
        position: fixed; inset: 0; width: 100%; height: 100%;
      }
      /* Emergency container the card is moved into when an ancestor traps
         position:fixed. It has no styles of its own on purpose: what gets positioned is the
         card's container, and a host with a box of its own could only get in the way. */
      .ig-fs-host { display: contents; }
      ${VIEW_TAG}[data-fs] ha-card {
        height: 100%; border-radius: 0; box-shadow: none; border: none;
      }
      .ig-container.ig-fs {
        height: 100%; padding: 0; gap: 0; background: #000;
      }
      /* The header (mode chip + REC) and Recordings are removed: neither of the two is something
         to tend to while someone is waiting at the door. The two buttons the contract requires
         (mic and unlock) stay there, floating over the image. */
      .ig-container.ig-fs .top-row, .ig-container.ig-fs .bottom-row { display: none !important; }
      .ig-container.ig-fs .feed-wrap {
        position: absolute; inset: 0; width: 100%;
        height: 100% !important; aspect-ratio: auto !important;
        border-radius: 0; border: none;
      }
      /* object-fit contain, not cover: cropping to fill the gap would leave whoever is at the
         door out of frame depending on the screen's shape. In a video doorbell that is not a
         cosmetic detail. */
      .ig-container.ig-fs .video-wrapper video { object-fit: contain; }

      /* The two buttons, floating over the image. They do NOT auto-hide: there is no timer
         that hides them, on purpose. */
      .ig-container.ig-fs .actions-row {
        position: absolute; left: 0; right: 0; bottom: 16px; z-index: 8;
        padding: 0; gap: 34px; pointer-events: none;
      }
      /* Gradient scrim under the floating controls. Not decoration: over a bright image (a
         doorway at noon) the white text of the labels and status line becomes illegible, and
         here what has to be read is "Door open" or "channel busy". */
      .ig-container.ig-fs .feed-wrap::after {
        content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 210px;
        background: linear-gradient(180deg, transparent, rgba(0,0,0,0.55) 60%, rgba(0,0,0,0.72));
        pointer-events: none; z-index: 4;
      }
      .ig-container.ig-fs .actions-row .action { pointer-events: auto; }
      .ig-container.ig-fs .action .btn {
        box-shadow: 0 6px 22px rgba(0,0,0,0.65);
        background: linear-gradient(135deg, rgba(22,35,54,0.92), rgba(29,45,66,0.92));
        backdrop-filter: blur(6px);
      }
      .ig-container.ig-fs .action .lbl {
        color: rgba(232,240,254,0.9); text-shadow: 0 1px 4px rgba(0,0,0,0.8);
      }
      /* The status line (door open, channel busy, no lock) also floats: it's where the user
         gets an answer when they press a button, and leaving it out of view in this mode would
         make it useless right when it's used the most. */
      /* Right above the buttons (which take up 16px margin + 80 for the button + 6 + label). */
      .ig-container.ig-fs .status-line {
        position: absolute; left: 0; right: 0; bottom: 136px; z-index: 7;
        pointer-events: none; text-shadow: 0 1px 4px rgba(0,0,0,0.85);
        color: rgba(232,240,254,0.85);
      }
      /* The HUD's bottom cluster (volume, quality, fullscreen) stays at the bottom on the
         RIGHT: the action buttons are centered, so on a wide screen they don't touch and it's
         where the user already learned to find them from normal mode. Only when the two don't
         fit side by side - a portrait phone - does it move above. Measured, not estimated: at
         412px width the centered block occupies ~119..293 and the right cluster ~253..398, i.e.
         40px of real overlap. The query is a CONTAINER query (the video frame itself), not a
         window one, for the same reason as the rest of the card: what matters is the video's
         width. */
      @container igfeed (max-width: 520px) {
        .ig-container.ig-fs .hud-bottom { bottom: 174px; }
      }

      /* ==========================================================================
         SIDE RAIL - VERTICAL video inside a LANDSCAPE frame (§1.9)
         The real case is a wall tablet, which lives permanently in landscape. A vertical video
         there occupies a central strip and leaves two big gaps on the sides.
         The solution is NOT to crop to fill: that throws away the top and bottom, which is
         exactly what was gained by rotating the sensor. The solution is to USE one of those gaps.
         Rules that admit no interpretation, from Inaki's correction after seeing iOS:
          - The video occupies the FULL height, edge to edge. In landscape, height is the
            scarce resource.
          - The rail is only as wide as the touch target it contains (RAIL_WIDTH in JS). A
            column of buttons, not a panel: the width the rail takes is height the video loses.
         _layoutRotation() sets the class by measuring the real frame, not a @container: this
         container is of type inline-size and therefore cannot be queried by aspect ratio.

         WITHOUT the .ig-fs prefix on purpose since 2026-09-07: this section used to only apply
         in fullscreen because only there did the buttons float over the video. Now that they
         float ALWAYS (see .actions-row/.status-line above), the rail has to be able to appear
         in normal mode too - it is literally the same landscape wallpanel, the card never
         leaves that mode. The decision of WHEN still belongs only to _layoutRotation()
         (real geometry), not to this sheet.

         --ig-rail-gap (Inaki, 2026-09-08, after seeing the real wallpanel: "The image should
         take up the full height, using the side for the buttons" - the rail was stuck to the
         FRAME EDGE, ~700px away from the image, because this section was brought over from
         fullscreen without the assumption that made it correct there: that the frame IS the
         screen, so "stuck to the frame" and "stuck to the image" were almost the same thing. In
         the embedded card they are not.
         _layoutRotation() calculates how much space is left to the right of the ALREADY
         CENTERED image once the rail's own width is reserved, and writes it here as a
         variable - with right: var(--ig-rail-gap) instead of right:0, the rail (and its scrim,
         and the gap the HUD leaves for it) stick to the REAL edge of the image whatever the
         frame's width, instead of to the frame's edge. The default value (0px) is the
         fullscreen case: there the margin is minimal by construction, so behavior doesn't
         change (or barely changes). */
      .ig-container.ig-rail .actions-row {
        left: auto; right: var(--ig-rail-gap, 0px); bottom: auto; top: 50%;
        transform: translateY(-50%);
        width: 104px; flex-direction: column; align-items: center; gap: 22px;
      }
      /* The readability scrim moves from the bottom band to the side, which is where the
         controls now are - and travels WITH the rail (same right: var(--ig-rail-gap)), so it
         doesn't end up lighting up a patch of empty black while the buttons read against
         nothing. */
      .ig-container.ig-rail .feed-wrap::after {
        left: auto; right: var(--ig-rail-gap, 0px); top: 0; bottom: 0; width: 168px; height: auto;
        background: linear-gradient(90deg, transparent, rgba(0,0,0,0.55) 55%, rgba(0,0,0,0.72));
      }
      /* The status line goes back to the very bottom: there are no buttons above it any more.
         Inaki, 2026-09-08, after seeing "System idle" floating to the left of the video in the
         wallpanel screenshot: this rule's left:0 is THE SAME bug as the rail's, surviving in
         another element - anchored to the FRAME's edge instead of the IMAGE's. And it's not
         cosmetic: it's the line that says "Door open" or "channel busy", exactly what needs to
         be read with someone waiting at the door.
         gap + RAIL_WIDTH is exactly leftoverPerSide (the margin the centered image already
         leaves on each side, see _layoutRotation) - with left AND right at that same distance
         from each frame edge, the status line's box measures EXACTLY the image's width, not the
         frame's. The right already added the gap (112px of clearance from the rail's edge,
         which is an offset relative to the RAIL and stays valid as is). */
      .ig-container.ig-rail .status-line {
        bottom: 14px;
        left: calc(var(--ig-rail-gap, 0px) + var(--ig-rail-width, 104px));
        right: calc(112px + var(--ig-rail-gap, 0px));
      }
      /* And the HUD cluster moves away from the rail so it doesn't overlap it - same reasoning
         as the status line: the fixed offset (118px) was for the rail stuck to the frame, and
         now the gap the rail leaves up to the frame has to be added to it. */
      .ig-container.ig-rail .hud-bottom { right: calc(118px + var(--ig-rail-gap, 0px)); bottom: 12px; }

      /* Level 2: our own fallback. The size comes from 'inset: 0' and 'width/height: auto', NOT
         viewport units, and that is deliberate: '100vw' INCLUDES the scrollbar and a
         position:fixed's containing block does not. On a scrolling dashboard -- most real
         ones -- '100vw' leaves the element about 10-17px wider than the visible area and causes
         horizontal overflow. With 'inset: 0' the element measures exactly the visible viewport,
         which is what's wanted and also what makes _enterFullscreen()'s check comparable.
         The !important are there to beat the 'width: 100%' set as an INLINE style on the
         element itself (see setConfig) and the mode's 'height: 100%'. */
      .ig-container.ig-fs-pseudo {
        position: fixed; inset: 0; z-index: 2147483000;
        width: auto !important; height: auto !important; max-width: none;
      }
      body.ig-fs-body-lock { overflow: hidden !important; }

      /* ---- 1.9.7: header with REC + bell on the right ---- */
      .top-right { display: flex; align-items: center; gap: 8px; margin-left: auto; }
      .bell-btn {
        position: relative; width: 30px; height: 30px; border-radius: 50%; border: none; padding: 0;
        background: var(--ig-surf2); color: var(--ig-muted); cursor: pointer;
        display: flex; align-items: center; justify-content: center;
      }
      .bell-btn ha-icon { --mdc-icon-size: 16px; }
      .bell-btn.unread { color: var(--ig-text); }
      .bell-dot {
        display: none; position: absolute; top: 3px; right: 3px; width: 8px; height: 8px;
        border-radius: 50%; background: var(--ig-red); border: 1.5px solid var(--ig-surf2);
      }
      .bell-btn.unread .bell-dot { display: block; }
      .mode-pill.pending { opacity: 0.7; }
      .mode-pill.pending .mode-pill-caret { animation: ig-breathe 1.1s ease-in-out infinite; }

      /* ---- 1.9.7: STACK MODE (portrait phone), copied from the iOS app: video on top, chips
         below, buttons outside the image, Recordings at the end. _fitToSpace() sets the class
         and moves .actions-row to #stack-controls. ---- */
      .stack-controls { display: none; }
      .ig-container.ig-stack .feed-wrap { order: 0; }
      .ig-container.ig-stack .top-row { order: 1; }
      .ig-container.ig-stack .stack-controls { order: 2; display: block; }
      .ig-container.ig-stack .bottom-row { order: 3; }
      .ig-container.ig-stack .ev-panel { order: 4; }
      .ig-container.ig-stack .feed-wrap::after { display: none; }
      .ig-container.ig-stack .hud-bottom { bottom: 12px; }
      /* The date/time is burned into the video's top-left corner: the live chip moves below
         it, as in the app (measured from its screenshot, 2026-09-25). */
      .ig-container.ig-stack .hud-top { top: 36px; }
      .ig-container.ig-stack .status-line { bottom: 58px; left: 12px; right: 12px; }
      .ig-container.ig-stack .actions-row {
        position: static; display: flex; justify-content: center; align-items: center;
        gap: 30px; padding: 4px 0 2px; pointer-events: auto; min-height: 120px; box-sizing: border-box;
      }
      /* The app's size hierarchy (Inaki: «the main button is bigger by comparison and doesn't
         look easy to confuse»): mic 96, door 60, sound 48 - measured from its screenshot. */
      .ig-container.ig-stack .action .btn.mic { width: 96px; height: 96px; }
      .ig-container.ig-stack .action .btn.mic ha-icon { --mdc-icon-size: 36px; }
      .ig-container.ig-stack .action .btn.door { width: 60px; height: 60px; }
      .ig-container.ig-stack .action .btn.door ha-icon { --mdc-icon-size: 26px; }
      .ig-container.ig-stack .action .btn.snd { width: 48px; height: 48px; }
      .ig-container.ig-stack .action .btn.snd ha-icon { --mdc-icon-size: 20px; }
      .ig-container.ig-stack .action .btn { background: linear-gradient(135deg, var(--ig-surf2), var(--ig-surf3)); backdrop-filter: none; box-shadow: none; }
      .ig-container.ig-stack .action .lbl { color: var(--ig-muted); text-shadow: none; font-size: 12px; }
      .ig-container.ig-stack .quick-btn { padding: 12px 14px; }
      .ig-container.ig-stack .quick-btn-label { font-size: 14px; font-weight: 600; color: var(--ig-text); }
      /* In STACK (portrait phone, the narrowest case: 375-390px) the two buttons at 14px with
         the padding above don't fit as two halves -- the more compact .half size is inherited
         instead of the general stack one, and the label is allowed to wrap (rule above) instead
         of getting cut off. */
      .ig-container.ig-stack .quick-btn.half { padding: 10px 8px; }
      .ig-container.ig-stack .quick-btn.half .quick-btn-label { font-size: 12px; font-weight: 600; color: var(--ig-text); }

      /* ---- 1.9.7: notifications panel (the bell), over the whole card ---- */
      .ev-panel {
        position: absolute; inset: 0; z-index: 40; background: var(--ig-bg);
        flex-direction: column; gap: 8px; padding: 10px; box-sizing: border-box; min-height: 0;
      }
      .ev-head { display: flex; align-items: center; gap: 6px; }
      .ev-back { width: 34px; height: 34px; border-radius: 50%; border: none; background: var(--ig-surf1); color: var(--ig-text); cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 0; }
      .ev-back ha-icon { --mdc-icon-size: 22px; }
      .ev-title { font-size: 17px; font-weight: 700; color: var(--ig-text); }
      .ev-chips { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 2px; scrollbar-width: none; flex-shrink: 0; }
      .ev-chip {
        flex-shrink: 0; padding: 6px 12px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.10);
        background: var(--ig-surf1); color: var(--ig-muted); font-size: 12px; font-weight: 600; cursor: pointer; font-family: inherit;
      }
      .ev-chip.sel { background: rgba(25,118,210,0.22); border-color: var(--ig-blue); color: var(--ig-text); }
      .ev-time { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
      .ev-range {
        flex: 0 1 auto; min-width: 0; padding: 6px 8px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.10);
        background: var(--ig-surf1); color: var(--ig-text); font-size: 13px; font-family: inherit;
      }
      .ev-nav { display: flex; align-items: center; gap: 2px; margin-left: auto; min-width: 0; }
      .ev-navb { width: 30px; height: 30px; border-radius: 50%; border: none; background: var(--ig-surf1); color: var(--ig-text); cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 0; }
      .ev-navb:disabled { opacity: 0.3; cursor: default; }
      .ev-period { font-size: 13px; font-weight: 600; color: var(--ig-text); padding: 0 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .ev-list { flex: 1 1 auto; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; }
      .ev-day { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--ig-dim); padding: 8px 2px 2px; }
      .ev-row { display: flex; align-items: center; gap: 10px; padding: 9px 10px; border-radius: 14px; background: var(--ig-surf1); }
      .ev-row.new { box-shadow: inset 3px 0 0 var(--ig-blue); }
      .ev-ic { width: 32px; height: 32px; border-radius: 10px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; background: rgba(148,163,184,0.12); color: var(--ig-muted); }
      .ev-ic ha-icon { --mdc-icon-size: 17px; }
      .ev-ic.c-blue { background: rgba(25,118,210,0.16); color: #64B5F6; }
      .ev-ic.c-green { background: rgba(76,175,80,0.16); color: var(--ig-green); }
      .ev-ic.c-amber { background: rgba(255,179,0,0.16); color: var(--ig-amber); }
      .ev-ic.c-red { background: rgba(239,83,80,0.16); color: var(--ig-red); }
      .ev-txt { flex: 1 1 auto; min-width: 0; }
      .ev-t { font-size: 13px; font-weight: 600; color: var(--ig-text); }
      .ev-d { font-size: 11px; color: var(--ig-muted); margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ev-h { font-size: 12px; color: var(--ig-muted); flex-shrink: 0; font-variant-numeric: tabular-nums; }
      .ev-empty { margin: auto; text-align: center; color: var(--ig-muted); font-size: 13px; padding: 24px 12px; display: flex; flex-direction: column; align-items: center; gap: 6px; }
      .ev-empty ha-icon { --mdc-icon-size: 32px; color: var(--ig-dim); }
      .ev-empty-t { color: var(--ig-text); font-weight: 600; }

      /* Quick reply (v1.9.8): #qr-panel's rows are <button>, unlike #ev-panel's (<div>,
         read-only) -- reset of what the browser puts on a <button> by default; the rest of the
         look (background, radius, icon) already comes from the reused .ev-row/.ev-ic. */
      .qr-row { border: none; width: 100%; text-align: left; font-family: inherit; cursor: pointer; }
      .qr-row:hover:not(:disabled) { background: var(--ig-surf2); }
      .qr-row:disabled { opacity: 0.55; cursor: default; }
      .qr-spin { animation: ig-spin 1s linear infinite; }
      .qr-notice {
        font-size: 12px; color: var(--ig-red); background: rgba(239,83,80,0.12);
        border-radius: 12px; padding: 8px 10px;
      }

      /* ==========================================================================
         1.11.0 ADAPTIVE LAYOUT. Which layout is active is decided ONLY in JS (_planLayout /
         _applyLayout, measuring the card's real space); this sheet only draws each one. Exactly
         one of .ig-stack / .ig-side / (neither = overlay) is ever set.
         ========================================================================== */

      /* Touch targets: 44 px on touch devices (Apple HIG / WCAG 2.5.5). Measured in 1.10.0: mode chip
         32, REC 24, bell 30, fullscreen 30. A mouse keeps the compact sizes. --ig-tap is the same
         number for the pieces this block adds. */
      .ig-container { --ig-tap: 34px; }
      /* The picker shrinks with an ellipsis, but never below one target (it was squeezed to 26 px). */
      .db-picker { min-width: min(100%, 96px); }
      @media (pointer: coarse) {
        .ig-container { --ig-tap: 44px; }
        .db-pill, .mode-pill { min-height: 44px; box-sizing: border-box; }
        .rec-pill { height: 44px; padding: 0 12px; box-sizing: border-box; }
        .bell-btn { width: 44px; height: 44px; }
        .bell-btn ha-icon { --mdc-icon-size: 20px; }
        .bell-dot { top: 8px; right: 8px; }
        .hud-fs { width: 44px; height: 44px; padding: 0; }
        .ev-back, .ev-navb { width: 44px; height: 44px; }
        .mode-menu .mode-opt { min-height: 44px; }
        .ev-chip { min-height: 44px; }
      }
      /* Hidden from the eye, not from a screen reader (the button keeps its name). */
      .ig-vh-lbl, .ig-container.ig-side-compact .side-col .action .lbl,
      .ig-container.ig-side-compact .side-col .rec-pill-label,
      .ig-container.ig-side-compact .side-col .quick-btn-label,
      .ig-container.ig-short .top-right .quick-btn-label {
        position: absolute !important; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap;
      }

      /* ---- SIDE COLUMN (.ig-side): video at full height + a column hugging the image's right edge.
         JS sizes the frame to the image (inline width/height) and the column to the same height;
         the pair is centred in the card. Everything else lives in the column, in this order:
         picker / mode / REC + bell, then sound / mic / door, then Recordings / Quick replies. ---- */
      .side-col { display: none; }
      .ig-container.ig-side { flex-direction: row; justify-content: center; align-items: flex-start; }
      .ig-container.ig-side .feed-wrap { flex: none; }
      .ig-container.ig-side .side-col {
        display: flex; flex-direction: column; justify-content: space-between; gap: 10px;
        width: var(--ig-side-w, 144px); flex: none; box-sizing: border-box; min-height: 0;
      }
      .ig-container.ig-side .side-col .top-row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; align-items: stretch; }
      .ig-container.ig-side .side-col .top-left, .ig-container.ig-side .side-col .top-right { display: contents; }
      .ig-container.ig-side .side-col .db-picker, .ig-container.ig-side .side-col .mode-row { grid-column: 1 / -1; min-width: 0; }
      .ig-container.ig-side .side-col .db-pill { width: 100%; min-height: var(--ig-tap); }
      .ig-container.ig-side .side-col .mode-pill { width: 100%; min-height: var(--ig-tap); justify-content: center; box-sizing: border-box; min-width: 0; }
      .ig-container.ig-side .side-col .mode-pill-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
      .ig-container.ig-side .side-col .rec-action-wrap { min-width: 0; }
      .ig-container.ig-side .side-col .rec-pill { width: 100%; height: var(--ig-tap); justify-content: center; box-sizing: border-box; }
      .ig-container.ig-side .side-col .bell-btn { width: 100%; height: var(--ig-tap); border-radius: 999px; }
      /* The menus open towards the picture (to the left), not out of the card. */
      .ig-container.ig-side .db-menu, .ig-container.ig-side .mode-menu { left: auto; right: 0; }
      .ig-container.ig-side .side-col .actions-row {
        position: static; transform: none; width: auto; left: auto; right: auto; top: auto; bottom: auto;
        flex-direction: column; justify-content: center; align-items: center; gap: 10px;
        pointer-events: auto; flex: 1 1 auto; min-height: 0; padding: 0;
      }
      .ig-container.ig-side .action .btn.door, .ig-container.ig-side .action .btn.snd { width: 56px; height: 56px; }
      .ig-container.ig-side .action .btn { background: linear-gradient(135deg, var(--ig-surf2), var(--ig-surf3)); backdrop-filter: none; box-shadow: none; }
      /* Low specificity ON PURPOSE: the state colours (.lbl.on-cyan/.on-green/.on-amber) must win. */
      .ig-side .lbl { color: var(--ig-muted); text-shadow: none; text-align: center; }
      .ig-container.ig-side .side-col .bottom-row { flex-direction: column; gap: 8px; }
      .ig-container.ig-side .side-col .quick-btn.half { flex: none; min-height: 48px; }
      .ig-container.ig-side .side-col .quick-btn.half .quick-btn-label { font-size: 12px; font-weight: 600; color: var(--ig-text); }
      /* Nothing floats over the picture's bottom any more: no veil; status line and HUD as in stack. */
      .ig-container.ig-side .feed-wrap::after { display: none; }
      .ig-container.ig-side .hud-bottom { bottom: 12px; }
      .ig-container.ig-side .hud-top { top: 36px; }
      .ig-container.ig-side .status-line { bottom: 58px; left: 12px; right: 12px; }

      /* Compact column (image shorter than SIDE_FULL_H): three 44 px targets in the header row
         (mode as its icon, REC as its dot, bell), buttons without labels, Recordings/Quick replies
         as two icons side by side. Measured ~336 px of content: fits SIDE_MIN_H (350). */
      .ig-container.ig-side-compact .side-col { gap: 8px; }
      .ig-container.ig-side-compact .side-col .top-row { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
      .ig-container.ig-side-compact .side-col .mode-row { grid-column: auto; }
      .ig-container.ig-side-compact .side-col .mode-pill { padding: 0; }
      .ig-container.ig-side-compact .side-col .mode-pill-label, .ig-container.ig-side-compact .side-col .mode-pill-caret { display: none; }
      .ig-container.ig-side-compact .side-col .mode-pill ha-icon { --mdc-icon-size: 18px; }
      .ig-container.ig-side-compact .side-col .rec-pill { padding: 0; }
      .ig-container.ig-side-compact .side-col .actions-row { gap: 8px; }
      .ig-container.ig-side-compact .action .btn.mic { width: 64px; height: 64px; }
      .ig-container.ig-side-compact .action .btn.mic ha-icon { --mdc-icon-size: 26px; }
      .ig-container.ig-side-compact .action .btn.door, .ig-container.ig-side-compact .action .btn.snd { width: 48px; height: 48px; }
      .ig-container.ig-side-compact .action .btn.door ha-icon, .ig-container.ig-side-compact .action .btn.snd ha-icon { --mdc-icon-size: 20px; }
      .ig-container.ig-side-compact .side-col .bottom-row { flex-direction: row; gap: 6px; }
      .ig-container.ig-side-compact .side-col .quick-btn.half { flex: 1 1 0; min-height: 44px; justify-content: center; padding: 6px 0; }

      /* ---- OVERLAY, short (.ig-short, e.g. a phone in landscape): Recordings / Quick replies move
         into the header as two icon buttons, and their row's height goes to the video. ---- */
      /* A narrow card that still ends up here (e.g. a 372 px sidebar column on a phone in landscape,
         where nothing else fits) can't hold picker + mode + four round buttons on one line: measured,
         the picker was squeezed to 26 px. The header wraps to a second line instead; the height
         correction in _fitToSpace() takes that line from the video. */
      .ig-container.ig-short .top-row { flex-wrap: wrap; row-gap: 8px; }
      .ig-container.ig-short .top-left { flex: 1 1 auto; }
      /* In a short frame there is no room ABOVE the buttons for the HUD cluster (the narrow-card rule
         lifts it 148 px, measured: the fullscreen button ended outside a 158 px frame). It goes to
         the top-right corner instead, across from the live tag. */
      .ig-container.ig-short .hud-bottom { top: 12px; bottom: auto; left: auto; }
      .ig-container.ig-short .top-right .bottom-row { gap: 8px; }
      .ig-container.ig-short .top-right .quick-btn.half {
        flex: none; width: var(--ig-tap); height: var(--ig-tap); min-height: 0; padding: 0;
        justify-content: center; border-radius: 999px; gap: 0;
      }
      .ig-container.ig-short .top-right .quick-btn-icon { width: auto; height: auto; background: none; }

    `;
    this.appendChild(style);
  }
}

// ==============================================================================
// THE CARD (1.10.0): NO CONFIGURATION, WITH A DOORBELL SELECTOR
// ==============================================================================
//
// Iñaki, 2026-09-26: «one card, choosing between doorbells in real time» and «the card has no
// configuration: it's configured in ONE place, the integration». `type: custom:ig-doorbell-card`
// is the whole YAML. Doorbells come from Home Assistant's device registry
// (identifier ['ig_doorbell', <device_id>], the one the integration registers), their
// entities from the registries (IgDoorbellView._autoEntity), and address/credential as
// always via the integration (get_connection_info / signaling proxy, ALWAYS local).
//
// ⚠️ WHY ONE INSTANCE PER DOORBELL AND NOT "CHANGE THE device_id" OF THE ONE THAT'S THERE.
// The known bug in BOTH apps when switching doorbells: the header changed name and the
// dot stayed green, announcing a doorbell with no session. It's the typical shape of a change made
// by "cleaning field by field": the list of things to clean always falls short on one. This card
// has dozens of fields per session (turn, quality, role, alerts, quick replies, rotation,
// pause...) and timers spread across the whole file. Here the change is STRUCTURAL: the
// old doorbell's instance gets destroyed (it hangs up with `bye` and releases everything that hangs
// outside itself, see _destroy) and a new one gets created, born blank by construction. A
// lagging callback from the old one writes, at most, into an element that's no longer on the page.
//
// Options from earlier versions (device_id, unlock_entity, ring_entity, rec_entity,
// mode_entity, motion_entity, unlock_duration, height, idle_release_seconds) are SILENTLY
// IGNORED: throwing an error would break the existing dashboard of whoever updates.
// ==============================================================================
const SELECTION_KEY = 'ig-doorbell-card-selected';

// Masonry card size: 1 unit = 50 px. Before the first layout (height 0) a typical card height
// (~600 px) is assumed, so Masonry doesn't stack everything into the first column.
function cardSizeFromHeight(h) {
  return h > 0 ? Math.max(1, Math.ceil(h / 50)) : 12;
}

function doorbellIdOfDevice(dev) {
  if (!dev || dev.disabled_by || !Array.isArray(dev.identifiers)) return null;
  const par = dev.identifiers.find((x) => Array.isArray(x) && x[0] === IG_DOMAIN && x[1]);
  return par ? String(par[1]) : null;
}

class IgDoorbellCard extends HTMLElement {
  static async getConfigElement() {
    return document.createElement(EDITOR_TAG);
  }

  static getStubConfig() {
    return {};
  }

  setConfig(config) {
    this.style.display = 'block';
    this.style.width = '100%';
    this.style.boxSizing = 'border-box';
    const legacyKeys = Object.keys(config || {}).filter((k) => !['type', 'view_layout', 'grid_options', 'visibility', 'layout_options'].includes(k));
    if (legacyKeys.length && !this._legacyWarned) {
      this._legacyWarned = true;
      console.info(`[ig-doorbell-card] this card has no options since 1.10.0; ignoring: ${legacyKeys.join(', ')} (everything is configured in the Islautopia Garage Doorbell integration)`);
    }
    this.config = {};
    this._onPick = this._onPick || ((id) => this._choose(id));
    this._sync();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._view) this._view.hass = hass;
    this._sync();
  }

  get hass() { return this._hass; }

  // (1.11.0) Masonry: the real height / 50 (see the view's getCardSize).
  getCardSize() { return cardSizeFromHeight(this.offsetHeight || (this._view && this._view.offsetHeight) || 0); }

  // (1.11.0) Sections view. Full width of the section by default (the card fits its height to the
  // screen by itself, so `rows: 'auto'`); half a section at least - under 6 of 12 columns the
  // picture is a stamp. Iñaki can still resize it in the editor; the layout follows the size.
  getGridOptions() { return { columns: 12, min_columns: 6, rows: 'auto', min_rows: 6 }; }

  // Same thing for Home Assistant 2024.8-2024.10, which asked `getLayoutOptions` on a 4-column grid.
  getLayoutOptions() { return { grid_columns: 4, grid_min_columns: 2, grid_rows: 'auto', grid_min_rows: 6 }; }

  connectedCallback() { this._sync(); }

  // The doorbell list: cached by the identity of hass.devices/hass.entities (Home Assistant
  // only replaces them when the registry changes); availability is read on every state
  // tick, which is cheap (one read per doorbell entity).
  _listDoorbells() {
    const hass = this._hass;
    if (!hass || !hass.devices) return [];
    if (!this._cache || this._cache.devices !== hass.devices || this._cache.entities !== hass.entities) {
      const base = [];
      for (const haId of Object.keys(hass.devices)) {
        const dev = hass.devices[haId];
        const id = doorbellIdOfDevice(dev);
        if (!id || base.some((d) => d.id === id)) continue;
        let name = String(dev.name_by_user || dev.name || '').trim();
        if (name === id) name = '';            // never the hex id as the name
        const ents = [];
        const all = hass.entities || {};
        for (const eid of Object.keys(all)) {
          const e = all[eid];
          if (e && e.device_id === haId && e.platform === IG_DOMAIN) ents.push(eid);
        }
        base.push({ id, name, ents });
      }
      base.sort((a, b) => (a.name || '~').localeCompare(b.name || '~') || a.id.localeCompare(b.id));
      this._cache = { devices: hass.devices, entities: hass.entities, base };
    }
    const states = hass.states || {};
    return this._cache.base.map((d) => {
      const knownStates = d.ents.map((e) => states[e]).filter(Boolean);
      const available = knownStates.length ? knownStates.some((st) => st.state !== 'unavailable') : null;
      return { id: d.id, name: d.name, available };
    });
  }

  _defaultDoorbell(list) {
    let savedValue = null;
    try { savedValue = localStorage.getItem(SELECTION_KEY); } catch (err) { /* no storage */ }
    if (savedValue && list.some((d) => d.id === savedValue)) return savedValue;
    return list[0].id;
  }

  _sync() {
    if (!this._hass || !this.config) return;
    const list = this._listDoorbells();
    if (!list.length) {
      // No doorbells: if one is already on screen it's left alone (a momentarily empty registry while
      // Home Assistant is starting up must not hang up a call); if there isn't one, it explains what's missing.
      if (!this._view) this._paintEmpty();
      return;
    }
    this._removeEmpty();
    const cur = this._view && this._view.config ? this._view.config.device_id : null;
    if (cur && list.some((d) => d.id === cur)) {
      this._view._setDoorbells(list, this._onPick);
      return;
    }
    if (!this.isConnected) return;      // it mounts on entering the page, not before
    this._switchTo(this._defaultDoorbell(list), cur ? 'the current doorbell is no longer in Home Assistant' : 'startup');
  }

  // The user picks from the selector. It's remembered per browser (localStorage), not in the YAML: the
  // card has no configuration and two screens in the house may want to look at different doorbells.
  _choose(id) {
    const list = this._listDoorbells();
    if (!list.some((d) => d.id === id)) return;
    try { localStorage.setItem(SELECTION_KEY, id); } catch (err) { /* no storage: this session only */ }
    this._switchTo(id, 'chosen in the selector');
  }

  // Synchronous from start to end ON PURPOSE: between destroying the old one and creating the new one there's no
  // `await` a second switch (a fast A->B->A) could slip into and leave two sessions.
  _switchTo(id, reason) {
    const oldView = this._view;
    if (oldView && oldView.config && oldView.config.device_id === id) return;
    this._view = null;
    if (oldView) {
      oldView._destroy(`doorbell change: ${reason}`);
      oldView.remove();
    }
    if (!id) return;
    console.info(`[ig-doorbell-card] doorbell in view: ${id} (${reason})`);
    const v = document.createElement(VIEW_TAG);
    v.hass = this._hass;
    v._setDoorbells(this._listDoorbells(), this._onPick);
    // Into the DOM BEFORE setConfig(): the other way around, render() starts one session and connectedCallback()
    // another (the 2026-08-03 test-harness note in CLAUDE.md).
    this.appendChild(v);
    v.setConfig({ device_id: id });
    this._view = v;
  }

  _paintEmpty() {
    if (!this._emptyCard) {
      this._emptyCard = document.createElement('ha-card');
      this._emptyCard.style.cssText = 'display:block;padding:16px;';
      this.appendChild(this._emptyCard);
    }
    this._emptyCard.textContent = getLocalText(this._hass, 'no_doorbells');
  }

  _removeEmpty() {
    if (this._emptyCard) { this._emptyCard.remove(); this._emptyCard = null; }
  }
}

// ==============================================================================
// VISUAL EDITOR (1.10.0): there's nothing to configure here
// ==============================================================================
class IgDoorbellCardEditor extends HTMLElement {
  set hass(hass) {
    this._hass = hass;
    this.render();
  }

  setConfig(config) {
    this._config = Object.assign({}, config);
    this.render();
  }

  render() {
    const lang = (this._hass && this._hass.language) || 'en';
    if (this._renderedLang === lang) return;
    this._renderedLang = lang;
    this.innerHTML = `
      <div style="padding: 8px 0; color: var(--primary-text-color); line-height: 1.5;">
        <ha-icon icon="mdi:information-outline" style="--mdc-icon-size:20px; vertical-align:middle; margin-right:6px; color: var(--secondary-text-color);"></ha-icon>
        <span>${getLocalText(this._hass, 'ed_nothing')}</span>
      </div>
    `;
  }
}

// Idempotency guards (found in real testing 2026-07-09, see COORDINATION.md): if
// this card is ALSO still installed via HACS (resource /hacsfiles/...) AT THE SAME TIME this
// file gets added as a manual resource (/local/...) to test changes before publishing a new
// release, the browser loads BOTH scripts - without this guard, the second `customElements.define`
// throws "has already been used with this registry" and crashes in the console (and, worse, depending
// on the load order, the code that "wins" could be HACS's old one, not the one being
// tested). This doesn't replace the real fix (keep only one resource active at a time, or publish
// a new HACS release before removing the manual resource) but it avoids the crash and makes
// it clear from the console which copy is actually active.
if (!customElements.get(EDITOR_TAG)) {
  customElements.define(EDITOR_TAG, IgDoorbellCardEditor);
} else {
  console.warn('[ig-doorbell-card] ig-doorbell-card-editor was already registered (there are probably two resources of this card loaded at the same time, e.g. HACS + /local/) - this copy of the script will not activate');
}

// One doorbell's view (1.10.0): the card creates it, never Home Assistant. It's registered BEFORE
// the card so the first `createElement('ig-doorbell-view')` already finds it defined.
if (!customElements.get(VIEW_TAG)) {
  customElements.define(VIEW_TAG, IgDoorbellView);
} else {
  console.warn('[ig-doorbell-card] ig-doorbell-view was already registered (two resources of this card loaded at the same time) - this copy of the script will not activate');
}

if (!customElements.get(CARD_TAG)) {
  customElements.define(CARD_TAG, IgDoorbellCard);

  window.customCards = window.customCards || [];
  if (!window.customCards.some((c) => c.type === CARD_TAG)) {
    window.customCards.push({
      type: CARD_TAG,
      name: "IG Doorbell",
      // No preview (1.10.0): with no configuration, the card picker's preview would open a
      // REAL video session against a doorbell just for browsing the list, and it would occupy one of its slots.
      preview: false,
      description: "Live video, two-way audio and door control for Islautopia Garage Doorbell (IG Doorbell). No options: everything is configured in the Islautopia Garage Doorbell integration."
    });
  }
} else {
  console.warn('[ig-doorbell-card] ig-doorbell-card was already registered (there are probably two resources of this card loaded at the same time, e.g. HACS + /local/) - this copy of the script will not activate');
}
