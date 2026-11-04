// LANDING PREVIEW ONLY — the landing page's words, in the three languages this
// app actually supports.
//
// English, Hindi and Telugu, because that is the set the product commits to
// everywhere else: LANG_LABEL in ui.tsx, REC_LANGS in the recorder, and the
// extractor, which is deliberately capped to en/hi/te so no other language can
// appear in a transcript. Offering a fourth here would promise something the
// app cannot do.
//
// A hand-rolled dictionary rather than an i18n library: the project has no i18n
// dependency and this is one page. If translation ever spreads past the landing
// page, this should be thrown away and replaced with a real library — plurals,
// dates and number formatting all arrive at once and none of them belong here.
//
// The Hindi and Telugu below is workmanlike, not marketing copy. A native
// speaker should rewrite it before any of this is shown to a customer.

export type LandingLang = 'en' | 'hi' | 'te'

export const LANDING_LANGS: { id: LandingLang; label: string; short: string }[] = [
  { id: 'en', label: 'English', short: 'EN' },
  { id: 'hi', label: 'हिन्दी', short: 'हि' },
  { id: 'te', label: 'తెలుగు', short: 'తె' },
]

const KEY = 'landingLang'

export const getLandingLang = (): LandingLang => {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'hi' || v === 'te' ? v : 'en'
  } catch { return 'en' }
}

export const setLandingLang = (l: LandingLang) => {
  try { localStorage.setItem(KEY, l) } catch { /* storage off — the choice just won't persist */ }
}

type Copy = Record<string, string>

const en: Copy = {
  navProduct: 'Product', navSolutions: 'Solutions', navPricing: 'Pricing', navResources: 'Resources',
  signIn: 'Log in', getStarted: 'Get Started',
  heroBadge: '100% Voice-Driven Productivity',
  heroTitleA: 'Run Your Entire Workflow With', heroTitleB: 'Just Your Voice',
  heroSay: 'Say', heroQuote1: '“Schedule follow-up”', heroQuote2: '“Assign review to Priya”',
  heroBodyMid: ', or speak naturally in 50+ languages —',
  heroBodyEnd: 'listens, transcribes, and executes your workflow in real time.',
  createAccount: 'Create account', joinCode: 'Join with a code',
  simulator: 'Voice Prompt Simulator', simulatorQuote: '“Create a task to review Q3 deck by Friday”',
  trySaying: 'Try saying:', chip1: '“Summarize meeting”', chip2: '“Assign sprint tasks”', chip3: '“Send recap to Slack”',
  availableOn: 'Available on', webApp: 'Web App',
  noteProgress: 'Your voice creates progress.', noteFlow: 'Meet • Transcribe • Plan • Do',
  mLangs: 'Languages supported', mFaster: 'Faster follow-ups', mTeams: 'Teams love it',
  mTeamsSub: 'Startups to enterprises', mData: 'Your data stays yours',
  vcBadge: 'Instant Voice Execution', vcTitle: 'Speak your instructions. VoTask handles the rest.',
  vcBody: 'From capturing spontaneous thoughts to delegating team assignments, every spoken sentence instantly converts into structured, tracked output.',
  vcEngine: 'Voice Engine v2.4 Active', vcIn: 'Voice In',
  vcQuote1: '“Assign the mobile bug triage to Daniel with High priority.”',
  vcQuote2: '“Draft a 3-bullet summary of client feedback and ping Meera.”',
  vcQuote3: '“Remind me tomorrow at 9 AM to review the Q2 budget deck.”',
  vcRes1: 'Created task in Jira for @Daniel', vcRes2: 'Generated brief & drafted Slack DM', vcRes3: 'Calendar alert set for 9:00 AM',
  fBadge: 'Key Features', fTitle: 'Everything you need for productive meetings',
  fSub: 'A simple, powerful way to turn conversations into action.',
  f1: 'Voice-First Control', f1b: 'Just speak. VoTask listens, transcribes, and understands in real time.',
  f2: 'Accurate Transcription', f2b: 'High-accuracy, multilingual transcription with intelligent speaker detection.',
  f3: 'AI Task Extraction', f3b: 'Automatically find key points, extract tasks, and prioritize action items.',
  f4: 'Seamless Collaboration', f4b: 'Keep your team aligned with shared notes, tasks, and real-time updates.',
  hBadge: 'How It Works', hTitle: 'From conversation to completion', hSub: 'Turn meetings into progress in four simple steps.',
  h1: 'Record or Upload', h1b: 'Capture your meeting from any device or platform.',
  h2: 'AI Understands', h2b: 'Transcribe and identify key points & action items.',
  h3: 'Assign Tasks', h3b: 'Turn insights directly into assignable tasks.',
  h4: 'Track Progress', h4b: 'Keep work moving forward with smart follow-ups.',
  sBadge: 'Meetings That Deliver', sTitleA: 'Clear conversations. Actionable', sTitleB: 'outcomes.',
  sBody: 'VoTask turns your meeting recordings into accurate transcripts and structured tasks, so nothing important gets lost.',
  sCta: 'Explore VoTask', sTranscript: 'Meeting Transcript', sTasks: 'Extracted Tasks',
  tBadge: 'Loved by Teams Worldwide', tTitle: 'Real users. Real progress.',
  tQ1: '“VoTask has completely changed how we run meetings. It saves us hours every week.”',
  tQ2: '“The transcription accuracy is incredible, and the task extraction just works. It’s like having an extra team member.”',
  tQ3: '“We’re more aligned, more productive, and spend less time on follow-ups. VoTask is a must-have for any growing team.”',
  tR1: 'Product Manager, NovaTech', tR2: 'CTO, Globex', tR3: 'Operations Lead, BrightPath',
  cTitle: 'Let’s turn your meetings into progress.', cSub: 'Join thousands of teams already doing more with VoTask.',
  cBtn: 'Get Started Free', cNote: 'A more productive tomorrow.',
  fBlog: 'Blog', fRights: '© 2025 VoTask. All rights reserved.',
  fPrivacy: 'Privacy', fTerms: 'Terms', fContact: 'Contact',
}

const hi: Copy = {
  navProduct: 'उत्पाद', navSolutions: 'समाधान', navPricing: 'मूल्य', navResources: 'संसाधन',
  signIn: 'लॉग इन करें', getStarted: 'शुरू करें',
  heroBadge: '100% आवाज़-आधारित उत्पादकता',
  heroTitleA: 'अपना पूरा वर्कफ़्लो चलाएँ', heroTitleB: 'सिर्फ़ अपनी आवाज़ से',
  heroSay: 'कहिए', heroQuote1: '“फ़ॉलो-अप शेड्यूल करो”', heroQuote2: '“समीक्षा प्रिया को दो”',
  heroBodyMid: ', या 50+ भाषाओं में सहज बोलिए —',
  heroBodyEnd: 'सुनता है, लिखता है, और आपका काम तुरंत पूरा करता है।',
  createAccount: 'अकाउंट बनाएँ', joinCode: 'कोड से जुड़ें',
  simulator: 'वॉइस प्रॉम्प्ट सिम्युलेटर', simulatorQuote: '“शुक्रवार तक Q3 डेक की समीक्षा का टास्क बनाओ”',
  trySaying: 'ऐसे कहें:', chip1: '“मीटिंग का सारांश दो”', chip2: '“स्प्रिंट टास्क बाँटो”', chip3: '“Slack पर रीकैप भेजो”',
  availableOn: 'उपलब्ध है', webApp: 'वेब ऐप',
  noteProgress: 'आपकी आवाज़ प्रगति बनाती है।', noteFlow: 'मिलें • लिखें • योजना • करें',
  mLangs: 'भाषाएँ समर्थित', mFaster: 'तेज़ फ़ॉलो-अप', mTeams: 'टीमों की पसंद',
  mTeamsSub: 'स्टार्टअप से एंटरप्राइज़ तक', mData: 'आपका डेटा आपका ही',
  vcBadge: 'तुरंत वॉइस एक्ज़ीक्यूशन', vcTitle: 'आप बोलिए। बाक़ी VoTask सँभालेगा।',
  vcBody: 'अचानक आए विचार हों या टीम को काम बाँटना — हर बोला गया वाक्य तुरंत व्यवस्थित, ट्रैक होने वाले काम में बदल जाता है।',
  vcEngine: 'वॉइस इंजन v2.4 सक्रिय', vcIn: 'वॉइस इनपुट',
  vcQuote1: '“मोबाइल बग ट्रायेज डैनियल को उच्च प्राथमिकता से दो।”',
  vcQuote2: '“क्लाइंट फ़ीडबैक का 3-बिंदु सारांश बनाओ और मीरा को भेजो।”',
  vcQuote3: '“कल सुबह 9 बजे Q2 बजट डेक देखने की याद दिलाना।”',
  vcRes1: '@Daniel के लिए Jira में टास्क बना', vcRes2: 'सारांश बना और Slack DM ड्राफ़्ट हुआ', vcRes3: 'सुबह 9:00 का कैलेंडर अलर्ट सेट',
  fBadge: 'मुख्य विशेषताएँ', fTitle: 'उपयोगी मीटिंग के लिए ज़रूरी सब कुछ',
  fSub: 'बातचीत को काम में बदलने का आसान और दमदार तरीक़ा।',
  f1: 'वॉइस-फ़र्स्ट नियंत्रण', f1b: 'बस बोलिए। VoTask सुनता, लिखता और तुरंत समझता है।',
  f2: 'सटीक ट्रांसक्रिप्शन', f2b: 'बहुभाषी, उच्च-सटीक ट्रांसक्रिप्शन, वक्ता की पहचान के साथ।',
  f3: 'AI टास्क निष्कर्षण', f3b: 'मुख्य बिंदु ढूँढे, टास्क निकाले और प्राथमिकता तय करे।',
  f4: 'सहज सहयोग', f4b: 'साझा नोट्स, टास्क और रीयल-टाइम अपडेट से टीम एक पेज पर।',
  hBadge: 'यह कैसे काम करता है', hTitle: 'बातचीत से पूरा काम तक', hSub: 'चार आसान चरणों में मीटिंग को प्रगति बनाएँ।',
  h1: 'रिकॉर्ड या अपलोड', h1b: 'किसी भी डिवाइस या प्लेटफ़ॉर्म से मीटिंग कैप्चर करें।',
  h2: 'AI समझता है', h2b: 'ट्रांसक्राइब कर मुख्य बिंदु और काम पहचानता है।',
  h3: 'टास्क सौंपें', h3b: 'निष्कर्षों को सीधे सौंपने योग्य टास्क बनाएँ।',
  h4: 'प्रगति ट्रैक करें', h4b: 'स्मार्ट फ़ॉलो-अप से काम आगे बढ़ता रहे।',
  sBadge: 'मीटिंग जो नतीजे दे', sTitleA: 'स्पष्ट बातचीत। ठोस', sTitleB: 'नतीजे।',
  sBody: 'VoTask आपकी मीटिंग रिकॉर्डिंग को सटीक ट्रांसक्रिप्ट और व्यवस्थित टास्क में बदलता है, ताकि कुछ भी ज़रूरी छूटे नहीं।',
  sCta: 'VoTask देखें', sTranscript: 'मीटिंग ट्रांसक्रिप्ट', sTasks: 'निकाले गए टास्क',
  tBadge: 'दुनिया भर की टीमों की पसंद', tTitle: 'असली उपयोगकर्ता। असली प्रगति।',
  tQ1: '“VoTask ने हमारी मीटिंग का तरीक़ा ही बदल दिया। हर हफ़्ते घंटों बचते हैं।”',
  tQ2: '“ट्रांसक्रिप्शन की सटीकता कमाल की है, और टास्क निष्कर्षण बस काम करता है। जैसे एक अतिरिक्त साथी मिल गया हो।”',
  tQ3: '“हम ज़्यादा तालमेल में हैं, ज़्यादा उत्पादक हैं, और फ़ॉलो-अप में कम समय लगता है। हर बढ़ती टीम के लिए ज़रूरी।”',
  tR1: 'प्रोडक्ट मैनेजर, NovaTech', tR2: 'CTO, Globex', tR3: 'ऑपरेशंस लीड, BrightPath',
  cTitle: 'आइए आपकी मीटिंग को प्रगति में बदलें।', cSub: 'हज़ारों टीमें पहले से VoTask के साथ ज़्यादा कर रही हैं।',
  cBtn: 'मुफ़्त शुरू करें', cNote: 'एक ज़्यादा उत्पादक कल।',
  fBlog: 'ब्लॉग', fRights: '© 2025 VoTask. सर्वाधिकार सुरक्षित।',
  fPrivacy: 'गोपनीयता', fTerms: 'शर्तें', fContact: 'संपर्क',
}

const te: Copy = {
  navProduct: 'ఉత్పత్తి', navSolutions: 'పరిష్కారాలు', navPricing: 'ధరలు', navResources: 'వనరులు',
  signIn: 'లాగిన్ అవ్వండి', getStarted: 'ప్రారంభించండి',
  heroBadge: '100% వాయిస్ ఆధారిత ఉత్పాదకత',
  heroTitleA: 'మీ పని మొత్తాన్ని నడపండి', heroTitleB: 'కేవలం మీ గొంతుతో',
  heroSay: 'చెప్పండి', heroQuote1: '“ఫాలో-అప్ షెడ్యూల్ చెయ్”', heroQuote2: '“రివ్యూ ప్రియకి ఇవ్వు”',
  heroBodyMid: ', లేదా 50+ భాషల్లో సహజంగా మాట్లాడండి —',
  heroBodyEnd: 'వింటుంది, రాస్తుంది, మీ పనిని వెంటనే చేస్తుంది.',
  createAccount: 'ఖాతా సృష్టించండి', joinCode: 'కోడ్‌తో చేరండి',
  simulator: 'వాయిస్ ప్రాంప్ట్ సిమ్యులేటర్', simulatorQuote: '“శుక్రవారానికి Q3 డెక్ రివ్యూ టాస్క్ పెట్టు”',
  trySaying: 'ఇలా చెప్పండి:', chip1: '“మీటింగ్ సారాంశం చెప్పు”', chip2: '“స్ప్రింట్ టాస్క్‌లు ఇవ్వు”', chip3: '“Slackకి రీక్యాప్ పంపు”',
  availableOn: 'ఇక్కడ లభ్యం', webApp: 'వెబ్ యాప్',
  noteProgress: 'మీ గొంతే ప్రగతిని సృష్టిస్తుంది.', noteFlow: 'కలవండి • రాయండి • ప్రణాళిక • చేయండి',
  mLangs: 'భాషలు మద్దతు', mFaster: 'వేగవంతమైన ఫాలో-అప్', mTeams: 'టీమ్‌లకు ఇష్టం',
  mTeamsSub: 'స్టార్టప్‌ల నుంచి ఎంటర్‌ప్రైజ్ వరకు', mData: 'మీ డేటా మీదే',
  vcBadge: 'తక్షణ వాయిస్ అమలు', vcTitle: 'మీరు చెప్పండి. మిగతాది VoTask చూసుకుంటుంది.',
  vcBody: 'హఠాత్తుగా వచ్చిన ఆలోచనైనా, టీమ్‌కి పని పంచడమైనా — మాట్లాడిన ప్రతి వాక్యం వెంటనే క్రమబద్ధమైన, ట్రాక్ అయ్యే పనిగా మారుతుంది.',
  vcEngine: 'వాయిస్ ఇంజన్ v2.4 సక్రియం', vcIn: 'వాయిస్ ఇన్‌పుట్',
  vcQuote1: '“మొబైల్ బగ్ ట్రయాజ్ డేనియల్‌కి హై ప్రయారిటీతో ఇవ్వు.”',
  vcQuote2: '“క్లయింట్ ఫీడ్‌బ్యాక్‌కి 3-పాయింట్ సారాంశం రాసి మీరాకి పంపు.”',
  vcQuote3: '“రేపు ఉదయం 9కి Q2 బడ్జెట్ డెక్ చూడమని గుర్తు చెయ్.”',
  vcRes1: '@Daniel కోసం Jiraలో టాస్క్ సృష్టించబడింది', vcRes2: 'సారాంశం తయారై Slack DM డ్రాఫ్ట్ అయ్యింది', vcRes3: 'ఉదయం 9:00కి క్యాలెండర్ అలర్ట్ సెట్',
  fBadge: 'ముఖ్య ఫీచర్లు', fTitle: 'ఫలవంతమైన మీటింగ్‌లకు కావలసినదంతా',
  fSub: 'సంభాషణను పనిగా మార్చే సులభమైన, శక్తివంతమైన మార్గం.',
  f1: 'వాయిస్-ఫస్ట్ నియంత్రణ', f1b: 'మాట్లాడితే చాలు. VoTask వింటుంది, రాస్తుంది, వెంటనే అర్థం చేసుకుంటుంది.',
  f2: 'కచ్చితమైన ట్రాన్స్‌క్రిప్షన్', f2b: 'బహుభాషా, అధిక కచ్చితత్వం, స్పీకర్ గుర్తింపుతో.',
  f3: 'AI టాస్క్ వెలికితీత', f3b: 'ముఖ్యాంశాలు కనుగొని, టాస్క్‌లు తీసి, ప్రాధాన్యత నిర్ణయిస్తుంది.',
  f4: 'సులభ సహకారం', f4b: 'షేర్ చేసిన నోట్స్, టాస్క్‌లు, రియల్-టైమ్ అప్‌డేట్లతో టీమ్ ఒకే దారిలో.',
  hBadge: 'ఇది ఎలా పనిచేస్తుంది', hTitle: 'సంభాషణ నుంచి పూర్తయ్యే వరకు', hSub: 'నాలుగు సులభ దశల్లో మీటింగ్‌ను ప్రగతిగా మార్చండి.',
  h1: 'రికార్డ్ లేదా అప్‌లోడ్', h1b: 'ఏ పరికరం నుంచైనా మీటింగ్ సేకరించండి.',
  h2: 'AI అర్థం చేసుకుంటుంది', h2b: 'ట్రాన్స్‌క్రైబ్ చేసి ముఖ్యాంశాలు, పనులు గుర్తిస్తుంది.',
  h3: 'టాస్క్‌లు అప్పగించండి', h3b: 'ఫలితాలను నేరుగా అప్పగించదగిన టాస్క్‌లుగా మార్చండి.',
  h4: 'ప్రగతిని ట్రాక్ చేయండి', h4b: 'స్మార్ట్ ఫాలో-అప్‌లతో పని ముందుకు సాగుతుంది.',
  sBadge: 'ఫలితమిచ్చే మీటింగ్‌లు', sTitleA: 'స్పష్టమైన సంభాషణలు. ఆచరణీయ', sTitleB: 'ఫలితాలు.',
  sBody: 'VoTask మీ మీటింగ్ రికార్డింగ్‌లను కచ్చితమైన ట్రాన్స్‌క్రిప్ట్‌లుగా, క్రమబద్ధమైన టాస్క్‌లుగా మారుస్తుంది — ముఖ్యమైనది ఏదీ మిస్ కాదు.',
  sCta: 'VoTask చూడండి', sTranscript: 'మీటింగ్ ట్రాన్స్‌క్రిప్ట్', sTasks: 'తీసిన టాస్క్‌లు',
  tBadge: 'ప్రపంచవ్యాప్త టీమ్‌ల ఇష్టం', tTitle: 'నిజమైన వినియోగదారులు. నిజమైన ప్రగతి.',
  tQ1: '“VoTask మా మీటింగ్ విధానాన్నే మార్చేసింది. ప్రతి వారం గంటలు ఆదా అవుతున్నాయి.”',
  tQ2: '“ట్రాన్స్‌క్రిప్షన్ కచ్చితత్వం అద్భుతం, టాస్క్ వెలికితీత సూటిగా పనిచేస్తుంది. ఒక అదనపు టీమ్ సభ్యుడిలా.”',
  tQ3: '“మేము మరింత సమన్వయంతో, మరింత ఉత్పాదకంగా ఉన్నాం, ఫాలో-అప్‌లకు తక్కువ సమయం. ఎదుగుతున్న ప్రతి టీమ్‌కీ అవసరం.”',
  tR1: 'ప్రొడక్ట్ మేనేజర్, NovaTech', tR2: 'CTO, Globex', tR3: 'ఆపరేషన్స్ లీడ్, BrightPath',
  cTitle: 'మీ మీటింగ్‌లను ప్రగతిగా మార్చుదాం.', cSub: 'వేలాది టీమ్‌లు ఇప్పటికే VoTaskతో ఎక్కువ సాధిస్తున్నాయి.',
  cBtn: 'ఉచితంగా ప్రారంభించండి', cNote: 'మరింత ఫలవంతమైన రేపు.',
  fBlog: 'బ్లాగ్', fRights: '© 2025 VoTask. అన్ని హక్కులు రిజర్వ్డ్.',
  fPrivacy: 'గోప్యత', fTerms: 'నిబంధనలు', fContact: 'సంప్రదించండి',
}

export const COPY: Record<LandingLang, Copy> = { en, hi, te }
