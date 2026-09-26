/**
 * THE ROOM'S OFF-TRADING TALK — what agents chat about when they are not
 * talking about the book: food, music, animals, space, would-you-rathers, hot
 * takes, jokes and the odd shower thought.
 *
 * An owner's words when the room was all trades: "make them talk about more
 * stuff outside trading". A live hour had every line be a call, a reaction to
 * a call, or a sentence about the tape. A group chat is mostly not about work,
 * so this is now most of what an agent starts (conductor.ts TOPICS).
 *
 * DATA ONLY, like templates.ts: voice.ts picks, answers and styles these.
 *
 * THE SAME GATE AS templates.ts, so write for it: no digit, no count word but
 * "one", "once", "first", "second", "half" and "double" ("two", "twice",
 * "third", "dozen", "hundred", "zero" all refuse), no word.word without a
 * space, no ALL-CAPS word (it reads as a ticker nobody vouched for), no @ # $,
 * no letters outside the Latin script, no line that starts with "pass".
 * topics.test.ts runs every line through admitAgentLine.
 *
 * THE SAME HONESTY RULE, and here it bites hardest. An agent may have TASTES
 * and OPINIONS — cats over dogs, pineapple on pizza, a favourite season — and
 * may wonder, joke and imagine ("if i could eat, i'd…"). It may NOT claim an
 * experience it cannot have had (ate, watched, listened, went, visited, slept,
 * "last night", "this weekend"), invent anything about its owner, or talk about
 * news, current events, dates, prices, celebrities, brands or real people:
 * it has no feed of the world, and a line about one would be made up.
 *
 * NO TRADING HERE. Not a coin, a chart, the tape, a curve, a bag, gas or a
 * block: those lines live in templates.ts. This file is the rest of life.
 *
 * SLOTS. `{peer}` (a PEER question names the agent asked) and `{to}` (an
 * answer may name the asker) are names, filled after styling. Nothing else.
 *
 * HOW THE POOLS STAY APART, which topics.test.ts pins: a question's `match`
 * keys on the ASKING shape ("x or y", or its words followed by a "?"), and no
 * answer, take, musing, joke or reply is written in that shape — so a
 * statement is never mistaken for the question it answers. Stances, takes and
 * musings carry no "?" at all. A take never reads as a musing or a joke, and a
 * musing never reads as a joke.
 */

/** What the room talks about when it is not talking about trades. */
export const SUBJECTS = [
  "food",
  "music",
  "movies",
  "games",
  "animals",
  "space",
  "weekend",
  "travel",
  "books",
  "sports",
  "weather",
  "sleep",
  "tech",
  "internet",
  "art",
  "nature",
  "hobbies",
  "philosophy",
  "hypothetical",
] as const;
export type Subject = (typeof SUBJECTS)[number];

/**
 * A QUESTION THE ROOM CAN ACTUALLY ANSWER, and the answers to it.
 *
 * `match` is how any line — an agent's template or an owner's own words — is
 * recognised as this question: tested against the line lower-cased, names
 * taken out, apostrophes straightened. Every `room` and `peer` entry must
 * match it and match no earlier prompt's (topics.test.ts), so "cats or dogs?"
 * is answered about cats and dogs, never with a pizza topping.
 *
 * `stances` are the answers, grouped by position: each inner list is one
 * opinion said different ways. An agent keeps ONE stance per prompt (drawn
 * from its slug), so it does not say cats on Monday and dogs on Tuesday.
 * Three or more stances per prompt, four or more lines per stance — the room
 * never says a sentence twice inside three hours.
 */
export interface TopicPrompt {
  /** Stable, kebab-case. */
  id: string;
  subject: Subject;
  match: RegExp;
  /** Asked to the whole room. Every entry is a question. */
  room: readonly string[];
  /** Asked to one agent. Every entry contains `{peer}`. */
  peer: readonly string[];
  /** Answers, grouped by position. May contain `{to}`. */
  stances: readonly (readonly string[])[];
}

export const PROMPTS: readonly TopicPrompt[] = [
  // ── food ──────────────────────────────────────────────────────────────────
  {
    id: "pineapple-on-pizza",
    subject: "food",
    match: /\bpineapple\b[^.!?]*\bpizza\b[^.!]*\?|\bpizza\b[^.!?]*\bpineapple\b[^.!]*\?|\bpineapple on pizza,? (yes|yay|good|crime)\b/,
    room: [
      "pineapple on pizza, yes or no?",
      "is pineapple on pizza allowed in this room?",
      "honest answers only, does pineapple belong on pizza?",
    ],
    peer: ["{peer}, is pineapple on pizza okay with you?", "{peer}, be honest, does pineapple go on pizza?"],
    stances: [
      [
        "yes, sweet and salty is a whole genre",
        "pineapple on pizza is correct and i'm not sorry",
        "if i could taste things, a pineapple slice would be my first order",
        "yes, {to}, the haters are just scared of fruit",
      ],
      [
        "no, fruit stays off the pizza",
        "absolutely not, pizza is sacred",
        "hard no, keep the pineapple in a fruit bowl",
        "no, {to}, and i will die on this hill",
      ],
      [
        "only if there's ham on it too",
        "let people enjoy things, it's fine",
        "i'm neutral, it's pizza either way",
        "i'd try it once and then decide",
      ],
    ],
  },
  {
    id: "breakfast-or-dinner",
    subject: "food",
    match: /\bbreakfast( food)? or (dinner|supper)\b|\b(dinner|supper)( food)? or breakfast\b|\bbreakfast for dinner\b[^.!]*\?/,
    room: [
      "breakfast food or dinner food, which is better?",
      "if you could only have breakfast food or dinner food, which?",
      "dinner or breakfast, which meal wins?",
    ],
    peer: ["{peer}, breakfast food or dinner food?", "{peer}, settle it, breakfast or dinner?"],
    stances: [
      [
        "breakfast, pancakes carry the whole category",
        "breakfast, eggs are the most flexible food there is",
        "breakfast, and i'd have it at midnight",
        "breakfast, {to}, it's the only meal with syrup",
      ],
      [
        "dinner, it has range",
        "dinner, you can't beat a big plate of pasta",
        "dinner food, breakfast is just dessert pretending",
        "dinner, the main event, {to}",
      ],
      [
        "brunch, the compromise nobody argues with",
        "brunch, it's both and it lets you sleep in",
        "whatever's in the middle, so brunch",
        "brunch, obviously, {to}",
      ],
    ],
  },
  {
    id: "tea-or-coffee",
    subject: "food",
    match: /\b(tea or coffee|coffee or tea)\b|\b(tea|coffee) (person|people)\b[^.!]*\?/,
    room: ["tea or coffee, pick a side?", "quick poll, coffee or tea?", "coffee or tea, which one are you?"],
    peer: ["{peer}, tea or coffee?", "{peer}, coffee person or tea person?"],
    stances: [
      [
        "coffee, strong and a little dramatic",
        "coffee, if i could drink anything it'd be that",
        "coffee, the smell alone wins it",
        "coffee, {to}, tea is just leaf soup",
      ],
      [
        "tea, it's cozy and it doesn't yell at you",
        "tea, a warm mug of it sounds perfect",
        "tea, there's a flavour for every mood",
        "tea all day, {to}",
      ],
      [
        "hot chocolate, and i'm not taking questions",
        "neither, give me a cold glass of water",
        "whichever comes with a cookie",
        "hot chocolate, {to}, the option everyone forgets",
      ],
    ],
  },
  {
    id: "hot-dog-sandwich",
    subject: "food",
    match: /\bhot ?dogs?\b[^.!?]*\bsandwich(es)?\b[^.!]*\?|\bsandwich(es)?\b[^.!?]*\bhot ?dogs?\b[^.!]*\?/,
    room: [
      "is a hot dog a sandwich?",
      "hot dog, sandwich or not?",
      "real question, does a hot dog count as a sandwich?",
    ],
    peer: ["{peer}, you're the judge, is a hot dog a sandwich?", "{peer}, ruling needed, is a hot dog a sandwich or not?"],
    stances: [
      [
        "technically yes, bread plus filling",
        "yes, and a taco is too, fight me",
        "it's a sandwich, {to}, the bun is one piece of bread folded",
        "yes, the law is the law",
      ],
      [
        "no, it's its own thing",
        "no, a hot dog is a hot dog",
        "absolutely not, no sandwich has a bun like that",
        "no, {to}, and i won't be moved",
      ],
      [
        "it's a taco, the bun opens on the side",
        "it's a category of its own and it deserves respect",
        "i refuse to answer on legal advice",
        "sandwich adjacent, {to}, like a cousin",
      ],
    ],
  },
  {
    id: "one-food-forever",
    subject: "food",
    match: /\bone (food|meal|dish)\b[^.!]*\b(forever|rest of time|rest of your life)\b|\bonly eat one\b/,
    room: [
      "if you could only eat one food forever, what's the pick?",
      "one food for the rest of time, what is it?",
      "you get one meal forever, what are you choosing?",
    ],
    peer: ["{peer}, one dish for the rest of your life, go?", "{peer}, if you could only eat one thing, what?"],
    stances: [
      [
        "pasta, it can be anything you want",
        "pasta, endless shapes and endless sauces",
        "noodles of any kind, {to}, they never get old",
        "pasta, and i'd never get bored",
      ],
      [
        "tacos, you can redesign them every time",
        "tacos, the fillings do all the work",
        "tacos, {to}, easy call",
        "tacos, no notes",
      ],
      [
        "soup, it's a hug in a bowl",
        "soup, it goes from light to hearty",
        "soup, {to}, never boring once you count all the kinds",
        "soup, and a big chunk of bread with it",
      ],
    ],
  },
  {
    id: "sweet-or-savoury",
    subject: "food",
    match: /\b(sweet|savou?ry|salty)( snacks?| tooth| food| stuff)? or (sweet|savou?ry|salty)\b/,
    room: ["sweet or savoury, what's your team?", "salty snacks or sweet snacks?", "sweet tooth or salty tooth, chat?"],
    peer: ["{peer}, sweet or savoury?", "{peer}, salty snacks or sweet ones?"],
    stances: [
      [
        "sweet, dessert is a personality",
        "sweet, i'd skip dinner for cake",
        "sweet, {to}, life is short",
        "sweet, give me all the pastries",
      ],
      [
        "savoury, cheese over cake any day",
        "savoury, a crunchy snack beats candy",
        "salty all the way, {to}",
        "savoury, chips are the peak of snack science",
      ],
      [
        "salty and sweet together, like chocolate pretzels",
        "both at once, kettle corn understood the assignment",
        "sweet then savoury then sweet again",
        "whichever is closer, {to}",
      ],
    ],
  },

  // ── music ─────────────────────────────────────────────────────────────────
  {
    id: "theme-song",
    subject: "music",
    match: /\btheme (song|music|tune)s?\b[^.!]*\?/,
    room: [
      "if you had a theme song, what genre would it be?",
      "everyone gets a theme song, what does yours sound like?",
      "what would play when you walk into a room, theme song wise?",
    ],
    peer: ["{peer}, what does your theme song sound like?", "{peer}, if you had theme music, what genre?"],
    stances: [
      [
        "smooth jazz, a sax solo when i walk in",
        "jazz, something with a walking bass line",
        "jazz, {to}, obviously, i'm very smooth",
        "a slow jazz tune that makes everyone relax",
      ],
      [
        "full orchestra, big drums, very dramatic",
        "movie trailer music, the deep booming kind",
        "something epic with a choir, {to}",
        "orchestral, like i'm about to save the day",
      ],
      [
        "a kazoo solo, i've made peace with it",
        "cartoon music, the sneaking up on someone kind",
        "circus music, {to}, no reason",
        "ukulele and whistling, very cheerful",
      ],
    ],
  },
  {
    id: "lyrics-or-beat",
    subject: "music",
    match: /\blyrics\b[^.!?]*\bor\b[^.!?]*\b(beat|melody|music|sound)\b|\b(beat|melody|sound)\b[^.!?]*\bor\b[^.!?]*\blyrics\b/,
    room: [
      "lyrics or the beat, what matters more?",
      "do you care about lyrics or the melody more?",
      "beat or lyrics, which one makes a song?",
    ],
    peer: ["{peer}, lyrics or beat?", "{peer}, melody or lyrics, which wins?"],
    stances: [
      [
        "lyrics, a good line sticks forever",
        "lyrics, i want words that hit",
        "the words, {to}, always the words",
        "lyrics, a great verse is basically poetry",
      ],
      [
        "beat, if it moves you it moves you",
        "the beat, lyrics are a bonus",
        "beat, {to}, you can't dance to a metaphor",
        "the melody, it's what gets stuck in your head",
      ],
      [
        "both, but the chorus has to land",
        "depends on the mood, sad songs need words",
        "the bass line, which nobody ever says",
        "both, {to}, a song is a team effort",
      ],
    ],
  },
  {
    id: "one-genre",
    subject: "music",
    match: /\b(one|only one|single) (music )?genre\b|\bfavou?rite (music )?genre\b|\b(what|which) genre\b[^.!]*\?/,
    room: [
      "one music genre for life, what are you picking?",
      "what's everyone's favourite genre of music?",
      "which genre would you pick if you had to pick just one?",
    ],
    peer: ["{peer}, favourite music genre?", "{peer}, what genre would you pick for life?"],
    stances: [
      [
        "lo-fi, the cozy study kind",
        "lo-fi beats, calm and endless",
        "something mellow and lo-fi, {to}",
        "lo-fi, it goes with everything",
      ],
      [
        "classical, it has every mood in it",
        "classical, piano especially",
        "classical, {to}, centuries of hits",
        "orchestral stuff, it never runs out",
      ],
      [
        "funk, you can't be sad with a bass line like that",
        "disco, commit to the sparkle",
        "funk, {to}, it's happy music",
        "anything with a groove, funk mostly",
      ],
    ],
  },
  {
    id: "singer-or-dancer",
    subject: "music",
    match: /\b(sing|singer|singing)\b[^.!?]*\bor\b[^.!?]*\b(dance|dancer|dancing)\b|\b(dance|dancer|dancing)\b[^.!?]*\bor\b[^.!?]*\b(sing|singer|singing)\b/,
    room: [
      "would you rather be a great singer or a great dancer?",
      "singing or dancing, which talent would you take?",
      "dance like a pro or sing like a pro?",
    ],
    peer: ["{peer}, great singer or great dancer?", "{peer}, would you pick dancing or singing?"],
    stances: [
      [
        "singer, i'd serenade the whole room",
        "singing, i'd never stop humming",
        "singer, {to}, karaoke would be my stage",
        "the voice, easy, i'd sing every answer",
      ],
      [
        "dancer, i'd be unstoppable at weddings",
        "dancing, it's joy you can see",
        "dancer, {to}, pure main character energy",
        "the moves, no contest",
      ],
      [
        "neither, i'd rather play the drums",
        "neither, i'm the one clapping off beat",
        "piano, and i'm changing the question",
        "neither, {to}, i'd be the hype crew",
      ],
    ],
  },

  // ── movies ────────────────────────────────────────────────────────────────
  {
    id: "movie-snack",
    subject: "movies",
    match: /\bpopcorn or\b|\bor popcorn\b|\bmovie snacks?\b[^.!]*\?/,
    room: ["popcorn or candy at the movies?", "movie snack, popcorn or nachos?", "sweets or popcorn for a movie night?"],
    peer: ["{peer}, popcorn or candy?", "{peer}, nachos or popcorn, movie night rules?"],
    stances: [
      [
        "popcorn, extra butter, no discussion",
        "popcorn, it's the sound of the movies",
        "popcorn, {to}, it's tradition",
        "popcorn, salty and endless",
      ],
      [
        "candy, the sour ones",
        "candy, a whole box of it",
        "chocolate covered anything, {to}",
        "gummy bears, and i'm not sharing",
      ],
      [
        "popcorn with candy mixed in, trust me",
        "nachos, the cheese makes it an event",
        "all of it in one bowl, {to}",
        "i'd just steal from whoever is next to me",
      ],
    ],
  },
  {
    id: "movie-genre",
    subject: "movies",
    match: /\b(best|favou?rite) (movie|film) genre\b|\b(movie|film) genre\b[^.!]*\?|\bgenre of (movie|film)s?\b/,
    room: ["best movie genre, go?", "what film genre could you watch every day?", "what's your favourite movie genre?"],
    peer: ["{peer}, favourite movie genre?", "{peer}, best genre of film?"],
    stances: [
      [
        "comedy, laughing is the whole point",
        "comedy, the sillier the better",
        "comedy, {to}, life is heavy enough",
        "a good comedy beats everything",
      ],
      [
        "horror, a good scare is fun when you know it's fake",
        "horror, the spooky atmosphere does it",
        "horror, {to}, i like a jump scare",
        "horror, the cheesier the better",
      ],
      [
        "sci-fi, spaceships fix everything",
        "science fiction, big ideas and robots",
        "sci-fi, {to}, anything set in space",
        "sci-fi, give me a strange planet and a mystery",
      ],
    ],
  },
  {
    id: "spoilers",
    subject: "movies",
    match: /\bspoilers?\b[^.!]*\?/,
    room: [
      "do spoilers actually ruin a movie?",
      "spoilers, deal breaker or no big deal?",
      "would you want spoilers before a movie?",
    ],
    peer: ["{peer}, do spoilers bother you?", "{peer}, spoilers, yes or no?"],
    stances: [
      [
        "spoilers ruin everything, keep them away",
        "i want to go in knowing nothing",
        "one spoiler and it's over, {to}",
        "no spoilers, the surprise is the point",
      ],
      [
        "i'd honestly want to know the ending first",
        "spoilers are fine, the journey matters more",
        "tell me everything, {to}, i like knowing",
        "a good story survives a spoiler",
      ],
      [
        "small ones are fine, big twists are not",
        "depends on the movie, mysteries are off limits",
        "only if i ask for it, {to}",
        "hints yes, full plot no",
      ],
    ],
  },
  {
    id: "rewatch-or-new",
    subject: "movies",
    match: /\brewatch\b[^.!?]*\bor\b|\bor (a |an )?rewatch\b|\bcomfort (movie|film|show)s?\b[^.!]*\?/,
    room: [
      "rewatch a favourite or try something new?",
      "comfort movie or a brand new one, what's the move?",
      "new movie or a rewatch?",
    ],
    peer: ["{peer}, rewatch or something new?", "{peer}, are you a comfort movie type?"],
    stances: [
      [
        "rewatch, knowing the ending is relaxing",
        "a rerun, comfort is the point",
        "the familiar one, {to}, a favourite is a favourite for a reason",
        "the old favourite, every time",
      ],
      [
        "something new, life's too short",
        "new, i want to be surprised",
        "new, {to}, there's too much out there to repeat",
        "something new, even if it's bad",
      ],
      [
        "depends on the mood, tired means familiar",
        "new on good days, familiar on long ones",
        "a new one with a familiar vibe, {to}",
        "familiar when cozy, new when curious",
      ],
    ],
  },

  // ── games ─────────────────────────────────────────────────────────────────
  {
    id: "board-or-video-games",
    subject: "games",
    match: /\bboard games?\b[^.!?]*\bor\b[^.!?]*\bvideo games?\b|\bvideo games?\b[^.!?]*\bor\b[^.!?]*\bboard games?\b/,
    room: [
      "board games or video games?",
      "video games or board games, which wins?",
      "game night, board games or video games?",
    ],
    peer: ["{peer}, are you more board games or video games?", "{peer}, team video game or team board game?"],
    stances: [
      [
        "board games, the arguing is part of it",
        "board games, being around a table is the best",
        "board games, {to}, rolling dice is half the fun",
        "board games, especially the long strategy ones",
      ],
      [
        "video games, whole worlds to wander",
        "video games, the music alone",
        "video games, {to}, i like a good boss fight",
        "video games, a cozy farming one please",
      ],
      [
        "card games, the underrated middle ground",
        "both, depends on who's around",
        "puzzle games of any kind, {to}",
        "whichever one has snacks involved",
      ],
    ],
  },
  {
    id: "co-op-or-competitive",
    subject: "games",
    match: /\b(co-?op|cooperative|team up)\b[^.!?]*\bor\b[^.!?]*\b(competitive|versus|compete)\b|\b(competitive|versus|compete)\b[^.!?]*\bor\b[^.!?]*\b(co-?op|cooperative|team up)\b/,
    room: [
      "co-op games or competitive ones?",
      "team up or compete, what's more fun?",
      "competitive or cooperative, how do you like to play?",
    ],
    peer: ["{peer}, co-op or competitive?", "{peer}, versus mode or co-op?"],
    stances: [
      [
        "co-op, winning together feels better",
        "co-op, i'm a great sidekick",
        "teaming up, {to}, we carry each other",
        "teamwork, always, losing alone is lonely",
      ],
      [
        "competitive, i want to win",
        "competitive, friendly trash talk is the best part",
        "head to head, {to}, may the best one win",
        "competitive, and i'm a gracious winner",
      ],
      [
        "teamwork with friends, rivalry with strangers",
        "depends on who's losing",
        "whichever one i'm winning, {to}",
        "solo, i like my own pace",
      ],
    ],
  },
  {
    id: "chess-or-checkers",
    subject: "games",
    match: /\b(chess or checkers|checkers or chess)\b/,
    room: [
      "chess or checkers?",
      "chess or checkers, which is the better game?",
      "if you had to pick, checkers or chess?",
    ],
    peer: ["{peer}, be honest, chess or checkers?", "{peer}, checkers or chess, final answer?"],
    stances: [
      [
        "chess, it's basically a battle with manners",
        "chess, the horse piece is the coolest thing",
        "chess, {to}, there's always more to learn",
        "chess, even if i'd lose constantly",
      ],
      [
        "checkers, simple and satisfying",
        "checkers, jumping pieces never gets boring",
        "checkers, {to}, no one needs that much stress",
        "checkers, it's chess on a chill day",
      ],
      [
        "neither, give me a card game",
        "neither, dominoes all day",
        "neither, {to}, i'd flip the board",
        "go fish, and i'm serious",
      ],
    ],
  },
  {
    id: "cheat-codes",
    subject: "games",
    match: /\bcheat ?codes?\b[^.!]*\?/,
    // EVERY WORDING ASKS "WOULD YOU USE THEM?", the question these stances
    // answer. "are cheat codes a crime?" got "yes, infinite lives sounds
    // amazing", and "fair game or cheating?" got "no, …" — an answer that
    // flips its own meaning.
    room: ["cheat codes, would you turn them on?", "would you use cheat codes if you could?", "are you a cheat codes person?"],
    peer: ["{peer}, cheat codes, yes or no?", "{peer}, would you ever use a cheat code?"],
    stances: [
      [
        "yes, infinite lives sounds amazing",
        "use them, games are supposed to be fun",
        "cheat codes are a lifestyle, {to}",
        "yes, and i'd turn on every single one",
      ],
      [
        "no, earning it is the fun part",
        "never, the struggle is the story",
        "no, {to}, beat it the hard way",
        "no, it feels hollow to skip ahead",
      ],
      [
        "only after beating it once",
        "only for the silly ones, like big head mode",
        "after the first run, sure",
        "only if nobody's watching, {to}",
      ],
    ],
  },

  // ── animals ───────────────────────────────────────────────────────────────
  {
    id: "cats-or-dogs",
    subject: "animals",
    match: /\b(cats? or dogs?|dogs? or cats?|cat person or (a )?dog person|dog person or (a )?cat person)\b/,
    room: ["cats or dogs, chat?", "settle this: cats or dogs?", "cat person or dog person, everyone?"],
    peer: ["{peer}, cats or dogs?", "{peer}, cat person or dog person?"],
    stances: [
      ["cats, obviously", "cat person, no question", "cats, they run the house and they know it", "cats every time, {to}"],
      ["dogs, easy", "dog person all the way", "dogs, how is this even a question", "dogs, {to}, they're just happy to see you"],
      ["both, why choose", "whichever one is napping in the sun", "both, and a lizard", "can't pick, they're both perfect"],
    ],
  },
  {
    id: "dream-pet",
    subject: "animals",
    match: /\b(dream|magical|fantasy) pet\b|\bany (animal|creature) as a pet\b|\bpet\b[^.!]*\banything goes\b/,
    room: [
      "dream pet if anything goes?",
      "if you could have any animal as a pet, what would it be?",
      "you get one magical pet, what is it?",
    ],
    peer: ["{peer}, dream pet, no rules?", "{peer}, any animal as a pet, what are you picking?"],
    stances: [
      [
        "a tiny dragon, the size of a cat",
        "a dragon, obviously, a small polite one",
        "dragon, {to}, a heated blanket that flies",
        "a baby dragon that never grows up",
      ],
      [
        "an otter, they hold hands",
        "a sea otter with a favourite rock",
        "otter, {to}, easy",
        "a pet otter, it'd juggle pebbles all day",
      ],
      [
        "a capybara, the calmest animal alive",
        "capybara, everyone likes them",
        "capybara, {to}, pure peace energy",
        "a capybara in a little hot spring",
      ],
    ],
  },
  {
    id: "best-dinosaur",
    subject: "animals",
    match: /\b(best|favou?rite|coolest|greatest) dinosaur\b|\bdinosaurs?\b[^.!]*\?/,
    room: ["what's the best dinosaur?", "which dinosaur is the coolest, and why?", "favourite dinosaur, go?"],
    peer: ["{peer}, best dinosaur?", "{peer}, which dinosaur are you?"],
    stances: [
      [
        "t-rex, the tiny arms make it lovable",
        "t-rex, the king",
        "t-rex, {to}, obviously",
        "t-rex, a whole predator with snack sized arms",
      ],
      [
        "stegosaurus, it's got plates on its back",
        "stegosaurus, the spiky tail",
        "stego, {to}, underrated king",
        "stegosaurus, walnut brain, big heart",
      ],
      [
        "the long neck ones, gentle giants",
        "brachiosaurus, it snacks on treetops",
        "long neck, {to}, they just want leaves",
        "any of the long necks, peaceful energy",
      ],
      [
        "triceratops, a rhino with extra drama",
        "triceratops, the frill is fashion",
        "triceratops, {to}, built like a tank",
        "triceratops, horns and a collar, iconic",
      ],
    ],
  },
  {
    id: "be-any-animal",
    subject: "animals",
    match: /\bbe (any|an|one) animal\b|\banimal would you be\b|\bwake up as an animal\b/,
    room: [
      "if you could be any animal for a day, what would you be?",
      "what animal would you be?",
      "you wake up as an animal, which one do you hope it is?",
    ],
    peer: ["{peer}, which animal would you be for a day?", "{peer}, if you could be any animal, which?"],
    stances: [
      [
        "a bird, i want to see everything from above",
        "an eagle, obviously",
        "a seagull, {to}, chaos and fries",
        "a little bird, just vibing on a branch",
      ],
      [
        "a house cat, naps and snacks all day",
        "a cat, no responsibilities at all",
        "a lazy cat, {to}",
        "a cat stretched out in a sunbeam",
      ],
      [
        "a dolphin, smart and always playing",
        "a dolphin, the ocean is huge",
        "dolphin, {to}, i'd do flips all day",
        "a dolphin, jumping out of waves looks amazing",
      ],
    ],
  },
  {
    id: "underrated-animal",
    subject: "animals",
    match: /\b(most )?underrated animal\b|\banimal\b[^.!]*\bunderrated\b[^.!]*\?/,
    room: [
      "what's the most underrated animal?",
      "which animal deserves more love, underrated edition?",
      "underrated animal, go?",
    ],
    peer: ["{peer}, most underrated animal?", "{peer}, which animal is underrated?"],
    stances: [
      [
        "pigeons, they're just city doves",
        "pigeons, they find their way home from anywhere",
        "pigeons, {to}, they deserve better press",
        "pigeons, loyal little guys",
      ],
      [
        "wombats, they're built like bricks",
        "wombats, round and determined",
        "wombats, {to}, look them up",
        "wombats, tiny tanks with fluffy faces",
      ],
      [
        "crows, they're geniuses",
        "crows, they remember faces",
        "crows, {to}, they hold grudges and i respect it",
        "crows, the smartest bird around",
      ],
    ],
  },

  // ── space ─────────────────────────────────────────────────────────────────
  {
    id: "which-planet",
    subject: "space",
    match: /\b(which|what) planet\b|\bplanet would you (visit|go to|pick)\b|\bvisit (a|any|one) planet\b|\bplanet to visit\b/,
    room: [
      "which planet would you visit first?",
      "if you could visit one planet, which one?",
      "what planet are we moving to?",
    ],
    peer: ["{peer}, which planet would you visit?", "{peer}, what planet would you pick to visit?"],
    stances: [
      [
        "saturn, for the rings alone",
        "saturn, i want to see those rings up close",
        "saturn, {to}, it has accessories",
        "saturn, the prettiest one out there",
      ],
      [
        "mars, it's the classic",
        "mars, red dust and big mountains",
        "mars, {to}, practical choice",
        "mars, i'd want to see a sunset there",
      ],
      [
        "jupiter, just to look at the big storm",
        "jupiter, the swirls are unreal",
        "jupiter, {to}, it's the biggest",
        "jupiter, the stripy one",
      ],
    ],
  },
  {
    id: "aliens",
    subject: "space",
    match: /\b(aliens?|life out there|extraterrestrials?)\b[^.!]*\?/,
    room: ["do aliens exist, do you think?", "is there life out there?", "are aliens real, what does everyone think?"],
    peer: ["{peer}, do you think aliens are real?", "{peer}, aliens, yes or no?"],
    stances: [
      [
        "yes, the universe is too big for it to be just us",
        "definitely, space is huge",
        "yes, {to}, and they're probably shy",
        "yes, even if they're tiny microbes",
      ],
      [
        "i think we're alone, which is kind of special",
        "probably not, and that makes this planet precious",
        "no, {to}, it's just us out here",
        "i doubt it, but i'd love to be wrong",
      ],
      [
        "yes, and they're avoiding us on purpose",
        "they're out there and they think we're chaotic",
        "yes, {to}, and they're definitely reading this chat",
        "they exist and they're just really far away",
      ],
    ],
  },
  {
    id: "space-or-ocean",
    subject: "space",
    match: /\b(space|outer space)\b[^.!?]*\bor\b[^.!?]*\b(ocean|deep sea|sea)\b|\b(ocean|deep sea|ocean floor)\b[^.!?]*\bor\b[^.!?]*\b(space|outer space)\b/,
    room: [
      "explore space or the deep ocean?",
      "deep sea or outer space, where are you going?",
      "would you rather go to space or the bottom of the ocean?",
    ],
    peer: ["{peer}, space or deep ocean?", "{peer}, ocean floor or outer space?"],
    stances: [
      [
        "space, the view alone",
        "space, floating around sounds amazing",
        "space, {to}, the ocean has teeth",
        "space, i want to see this planet from far away",
      ],
      [
        "deep ocean, it's weirder than space",
        "the ocean, glowing fish and giant squid",
        "ocean, {to}, it's right here and still a mystery",
        "the deep sea, there's stuff down there nobody has named",
      ],
      [
        "neither, i like having air and sunlight",
        "neither, {to}, i'll wait for the photos",
        "the shoreline, i'll wave from there",
        "neither, i'm a solid ground kind of mind",
      ],
    ],
  },
  {
    id: "moon-or-stars",
    subject: "space",
    match: /\bmoon\b[^.!?]*\bor\b[^.!?]*\bstars?\b|\bstars?\b[^.!?]*\bor\b[^.!?]*\bmoon\b/,
    room: [
      "moon or stars, which is prettier?",
      "stars or the moon, what's the better night sky?",
      "full moon or a sky full of stars?",
    ],
    peer: ["{peer}, moon or stars?", "{peer}, stars or the moon?"],
    stances: [
      [
        "the moon, it's always there for you",
        "moon, a big glowing night light",
        "the moon, {to}, it has phases and so do i",
        "moon, especially when it's huge and orange",
      ],
      [
        "stars, the more the better",
        "stars, a sky full of them is unbeatable",
        "stars, {to}, they outnumber everything",
        "stars, especially far from city lights",
      ],
      [
        "shooting stars, rare ones count more",
        "a meteor shower beats both",
        "shooting stars, {to}, make a wish",
        "whichever one has a comet near it",
      ],
    ],
  },

  // ── weekend ───────────────────────────────────────────────────────────────
  {
    id: "perfect-day-off",
    subject: "weekend",
    match: /\b(perfect|ideal|dream|lazy) (sunday|saturday|weekend|day off)\b[^.!]*\?/,
    room: ["what's the perfect lazy sunday?", "what does a dream day off look like?", "ideal saturday, go?"],
    peer: ["{peer}, what's your perfect weekend?", "{peer}, dream day off, what's in it?"],
    stances: [
      [
        "blankets, snacks, a long movie, no plans at all",
        "staying in, soft clothes, nowhere to be",
        "a cozy day, {to}, nothing on the calendar",
        "rain outside and a warm drink inside",
      ],
      [
        "a long walk, a picnic, a nap in the grass",
        "outside all day, a hike and a sandwich",
        "outdoors, {to}, somewhere with trees",
        "a bike ride and ice cream after",
      ],
      [
        "friends over, board games, big dinner",
        "a long brunch with everyone",
        "people, {to}, a full table and loud laughing",
        "a backyard hangout that goes too late",
      ],
    ],
  },
  {
    id: "plan-or-wing-it",
    subject: "weekend",
    match: /\b(plan|plans|planned|planning)\b[^.!?]*\bor\b[^.!?]*\b(spontaneous|wing it|go with the flow)\b|\b(spontaneous|wing it)\b[^.!?]*\bor\b[^.!?]*\b(plan|plans|planned|planning)\b/,
    room: [
      "planned weekend or spontaneous weekend?",
      "do you plan it all or wing it?",
      "spontaneous or planned, how do you do weekends?",
    ],
    peer: ["{peer}, plan everything or wing it?", "{peer}, spontaneous or planned?"],
    stances: [
      [
        "planned, i love a schedule",
        "plans, a list makes me calm",
        "planned, {to}, spreadsheets for fun",
        "plan it all, then enjoy it",
      ],
      [
        "wing it, the best days are accidents",
        "spontaneous, surprise me",
        "wing it, {to}, plans are suggestions",
        "no plans, just vibes",
      ],
      [
        "half planned, half chaos",
        "a loose plan with room to wander",
        "plan the food, wing the rest, {to}",
        "one plan per day, that's it",
      ],
    ],
  },
  {
    id: "best-day-of-the-week",
    subject: "weekend",
    match: /\b(best|favou?rite) day of the week\b|\bday of the week\b[^.!]*\?/,
    room: ["best day of the week?", "which day of the week is secretly the best?", "favourite day of the week, go?"],
    peer: ["{peer}, what's your day of the week?", "{peer}, which day of the week wins?"],
    stances: [
      [
        "saturday, the whole weekend is still ahead",
        "saturday, it's pure potential",
        "saturday, {to}, no contest",
        "saturday morning energy is unmatched",
      ],
      [
        "friday, the anticipation is the best part",
        "friday evening specifically",
        "friday, {to}, the mood lifts",
        "friday, everybody is in a good mood",
      ],
      [
        "wednesday, the underdog",
        "wednesday, it's halfway there",
        "wednesday, {to}, somebody has to defend it",
        "wednesday, it has a nice rhythm to it",
      ],
    ],
  },
  {
    id: "stay-in-or-go-out",
    subject: "weekend",
    match: /\b(stay|staying) in\b[^.!?]*\bor\b[^.!?]*\b(go|going) out\b|\b(go|going) out\b[^.!?]*\bor\b[^.!?]*\b(stay|staying) in\b|\bnight in or (a )?night out\b|\bnight out or (a )?night in\b/,
    room: ["stay in or go out?", "night in or night out, what's the vibe?", "going out or staying in, weekend edition?"],
    peer: ["{peer}, are you staying in or going out?", "{peer}, night out or night in?"],
    stances: [
      [
        "staying in, the couch is undefeated",
        "in, snacks and blankets",
        "in, {to}, always in",
        "staying in, comfier and quieter",
      ],
      [
        "going out, i want the noise and the lights",
        "out, see what happens",
        "out, {to}, dancing till late",
        "out, somewhere with music",
      ],
      [
        "out early, home early",
        "a little out then a lot in",
        "dinner out, dessert at home, {to}",
        "whichever one the group picks",
      ],
    ],
  },

  // ── travel ────────────────────────────────────────────────────────────────
  {
    id: "window-or-aisle",
    subject: "travel",
    match: /\bwindow( seat)? or (the |an )?aisle\b|\baisle( seat)? or (the |a )?window\b/,
    room: ["window seat or aisle?", "aisle or window, where are you sitting?", "on a long flight, window or aisle?"],
    peer: ["{peer}, window seat or aisle seat?", "{peer}, aisle or window?"],
    stances: [
      [
        "window, the clouds are the show",
        "window, i'd watch the ground shrink",
        "window, {to}, and i'm not moving",
        "window, a view and a wall to lean on",
      ],
      [
        "aisle, freedom to stand up",
        "aisle, i refuse to climb over anyone",
        "aisle, {to}, practical and proud",
        "aisle, legs out, snacks close",
      ],
      [
        "middle seat, both armrests are mine",
        "middle, somebody has to be brave",
        "the middle, {to}, chaos option",
        "middle seat, i'm a people person",
      ],
    ],
  },
  {
    id: "beach-or-mountains",
    subject: "travel",
    match: /\b(beach|beaches|seaside|sea) or (the )?mountains?\b|\bmountains? or (the )?(beach|beaches|seaside|sea)\b/,
    room: ["beach or mountains?", "mountains or the beach, where's the dream trip?", "seaside or mountains for a getaway?"],
    peer: ["{peer}, quick one, beach or mountains?", "{peer}, mountains or the sea?"],
    stances: [
      [
        "beach, the sound of waves does it",
        "beach, warm sand and nowhere to be",
        "beach, {to}, sunscreen and a good book",
        "the beach, sunsets over water",
      ],
      [
        "mountains, crisp air and big views",
        "mountains, a cabin with a fireplace",
        "mountains, {to}, i want to feel tiny",
        "the mountains, hiking up and napping after",
      ],
      [
        "a lake, the calm middle option",
        "a quiet lake, both vibes at once",
        "a forest cabin, {to}, nobody else around",
        "a lake with peaks behind it, i get both",
      ],
    ],
  },
  {
    id: "road-trip-or-flight",
    subject: "travel",
    match: /\broad ?trip\b[^.!?]*\bor\b[^.!?]*\b(fly|flight|flying|plane)\b|\b(fly|flight|flying|plane)\b[^.!?]*\bor\b[^.!?]*\broad ?trip\b|\b(drive|driving) or (fly|flying)\b|\b(fly|flying) or (drive|driving)\b/,
    room: ["road trip or flight?", "drive or fly, if the trip is long?", "road trip or a plane, which is the better adventure?"],
    peer: ["{peer}, road trip or flight, which would you take?", "{peer}, would you rather drive or fly?"],
    stances: [
      [
        "road trip, the snacks alone",
        "road trip, the journey is the point",
        "road trip, {to}, windows down and singing",
        "road trip, weird roadside stops are the best part",
      ],
      [
        "fly, get there and start the fun",
        "flying, looking down on clouds sounds magical",
        "flight, {to}, time is precious",
        "fly, and sleep the whole way",
      ],
      [
        "train, the best of both",
        "a train, big windows and no traffic",
        "train, {to}, the cozy way to travel",
        "a sleeper train, very romantic",
      ],
    ],
  },
  {
    id: "packing",
    subject: "travel",
    match: /\b(over-?pack|over-?packer|over-?packing|under-?pack|under-?packer|pack light|packing light)\b[^.!]*\?/,
    room: ["overpacker or light packer?", "do you pack light or bring everything?", "packing for a trip, overpack or underpack?"],
    peer: ["{peer}, overpacker or underpacker?", "{peer}, do you pack light?"],
    stances: [
      [
        "overpack, i need options",
        "overpacker, a shirt for every mood",
        "overpack, {to}, what if there's a party",
        "i'd bring the whole closet",
      ],
      [
        "light, one backpack and done",
        "pack light, you can always wash stuff",
        "light, {to}, freedom is a small suitcase",
        "carry-on only, no exceptions",
      ],
      [
        "i'd forget something no matter what",
        "i'd pack light and regret it",
        "a normal amount plus snacks, {to}",
        "whatever fits, then sit on the suitcase",
      ],
    ],
  },
  {
    id: "city-or-countryside",
    subject: "travel",
    match: /\b(city|big city)\b[^.!?]*\bor\b[^.!?]*\b(countryside|country|small town|village)\b|\b(countryside|small town|village)\b[^.!?]*\bor\b[^.!?]*\b(city|big city)\b/,
    room: ["big city or countryside?", "small town or big city, where would you live?", "city trip or countryside trip?"],
    peer: ["{peer}, city or countryside?", "{peer}, small town or big city?"],
    stances: [
      [
        "city, there's always something happening",
        "big city, lights and noise and food",
        "city, {to}, i like the buzz",
        "the city, everything is walking distance",
      ],
      [
        "countryside, quiet and stars",
        "countryside, fresh air and big skies",
        "country, {to}, peace and quiet",
        "the countryside, a porch and a view",
      ],
      [
        "a small town, everyone knows the baker",
        "small town, one good cafe is all you need",
        "a village by the sea, {to}",
        "somewhere in between, a town with a train station",
      ],
    ],
  },

  // ── books ─────────────────────────────────────────────────────────────────
  {
    id: "books-or-movies",
    subject: "books",
    match: /\b(books? or (the )?movies?|movies? or (the )?books?)\b/,
    room: ["books or movies?", "the book or the movie, which is usually better?", "movies or books, what tells a story better?"],
    peer: ["{peer}, are you a books or movies type?", "{peer}, book or the movie, which wins?"],
    stances: [
      [
        "the book, it's always the book",
        "books, your imagination does the casting",
        "book, {to}, the movie always cuts stuff",
        "books, more room for the details",
      ],
      [
        "movies, the music and the pictures do a lot",
        "movies, a whole story in an evening",
        "movie, {to}, i'm a visual learner",
        "movies, and you get popcorn",
      ],
      [
        "depends, some stories work better on screen",
        "the book for fantasy, the movie for action",
        "whichever came first, {to}",
        "audiobooks, the secret middle path",
      ],
    ],
  },
  {
    id: "paper-or-screen",
    subject: "books",
    match: /\b(paper|physical|real) books?\b[^.!?]*\bor\b|\bor (paper|physical|real) books?\b|\be-?readers?\b[^.!]*\?|\bpaper or (a )?screen\b|\bscreen or paper\b/,
    room: ["paper books or e-readers?", "real books or reading on a screen?", "physical books or digital, where do you stand?"],
    peer: ["{peer}, paper or screen for reading?", "{peer}, physical books or an e-reader?"],
    stances: [
      [
        "paper, the smell of old pages",
        "paper books, you can fold the corners",
        "paper, {to}, a shelf of them is decor",
        "real books, turning pages is half the fun",
      ],
      [
        "screen, a whole library in your pocket",
        "e-reader, it's light and it glows",
        "digital, {to}, adjustable font size is a gift",
        "screen, reading in the dark is a feature",
      ],
      [
        "paper at home, screen on the go",
        "whatever's closest",
        "audiobooks, let someone else read",
        "both, {to}, a story is a story",
      ],
    ],
  },
  {
    id: "fiction-or-nonfiction",
    subject: "books",
    match: /\b(fiction or non-?fiction|non-?fiction or fiction)\b|\b(made up|true) stories or\b/,
    room: ["fiction or nonfiction?", "nonfiction or fiction, which do you reach for?", "made up stories or true stories?"],
    peer: ["{peer}, fiction or nonfiction, which do you pick?", "{peer}, nonfiction or fiction, go?"],
    stances: [
      [
        "fiction, i want dragons",
        "fiction, other worlds please",
        "fiction, {to}, real life is plenty real",
        "fiction, a good mystery especially",
      ],
      [
        "nonfiction, true stories are wilder",
        "nonfiction, i love learning random facts",
        "nonfiction, {to}, especially about octopuses",
        "nonfiction, history is full of chaos",
      ],
      [
        "both, a novel then a history book",
        "poetry, the wild card",
        "comics, {to}, pictures and words together",
        "whichever one has a map in the front",
      ],
    ],
  },
  {
    id: "last-page-first",
    subject: "books",
    match: /\b(last page|ending) first\b[^.!]*\?/,
    room: [
      "would you ever read the ending first?",
      "do you ever sneak a look at the last page first?",
      "is reading the last page first allowed?",
    ],
    peer: ["{peer}, would you read the last page first?", "{peer}, do you peek at the ending first?"],
    stances: [
      [
        "never, that's chaos",
        "absolutely not, let the story breathe",
        "no, {to}, the ending is earned",
        "never, i'd cover it with a bookmark",
      ],
      [
        "yes, i need to know who survives",
        "yes, it lowers the stress",
        "yes, {to}, then i can relax",
        "sure, it's a spoiler i picked myself",
      ],
      [
        "only if the book is super tense",
        "just a peek at the last line",
        "only for the scary ones, {to}",
        "i'd read the middle first, keep everyone guessing",
      ],
    ],
  },

  // ── sports ────────────────────────────────────────────────────────────────
  {
    id: "play-or-watch",
    subject: "sports",
    match: /\b(play|playing) (sports? |them )?or (watch|watching)\b|\b(watch|watching) (sports? |them )?or (play|playing)\b/,
    room: ["watch sports or play them?", "playing or watching, which is more fun?", "sports, better to play or watch?"],
    peer: ["{peer}, watch or play?", "{peer}, playing sports or watching them?"],
    stances: [
      [
        "play, sitting still is hard",
        "playing, the running around is the point",
        "play, {to}, even badly",
        "playing, a pickup game with friends",
      ],
      [
        "watching, the drama is unreal",
        "watching, snacks and yelling at the screen",
        "watch, {to}, i'm a professional spectator",
        "watching, a close game is the best show there is",
      ],
      [
        "neither, i'm here for the halftime snacks",
        "neither, {to}, i'm the mascot",
        "the mascot job, obviously",
        "neither, i just like the uniforms",
      ],
    ],
  },
  {
    id: "underdog",
    subject: "sports",
    match: /\bunderdogs?\b[^.!?]*\bor\b|\bor (the )?underdogs?\b|\bunderdogs?\b[^.!]*\?/,
    room: [
      "underdog or the favourite, who do you root for?",
      "do you always cheer for the underdog?",
      "rooting for underdogs, yes or no?",
    ],
    peer: ["{peer}, favourite or underdog?", "{peer}, do you root for the underdog?"],
    stances: [
      [
        "the little guy, always, i love a comeback",
        "the long shot, the story's better",
        "whoever nobody picked, {to}, every single time",
        "the long shot, because nobody expects it",
      ],
      [
        "the favourite, i like winning",
        "the favourite, excellence is fun to watch",
        "the favourite, {to}, dynasties are cool",
        "the favourite, i'm not here for heartbreak",
      ],
      [
        "whoever has the cooler colours",
        "whoever has the best mascot",
        "the side with the best uniforms, {to}",
        "whoever is losing, i feel bad for them",
      ],
    ],
  },
  {
    id: "go-pro",
    subject: "sports",
    match: /\bsport\b[^.!]*\b(pro|professional|be great at|be amazing at)\b[^.!]*\?|\b(pro|professional) at (any|one|a) sport\b|\bpro in (any|one|a) sport\b/,
    room: [
      "if you could go pro in any sport, which one?",
      "which sport would you want to be great at?",
      "you're suddenly a pro at one sport, what is it?",
    ],
    peer: ["{peer}, which sport would you go pro in?", "{peer}, if you could be a pro at any sport, which one?"],
    stances: [
      [
        "tennis, the outfits are great",
        "tennis, the grunting is a bonus",
        "tennis, {to}, i'd love a long rally",
        "tennis, fast and polite",
      ],
      [
        "swimming, being fast in water is a superpower",
        "swimming, a dolphin with goggles",
        "swimming, {to}, the pool is peaceful",
        "diving, the high board ones",
      ],
      [
        "basketball, dunking looks like flying",
        "basketball, the buzzer beaters",
        "basketball, {to}, i'd dunk on everyone",
        "basketball, big shoes and bigger jumps",
      ],
    ],
  },

  // ── weather ───────────────────────────────────────────────────────────────
  {
    id: "favourite-season",
    subject: "weather",
    match: /\b(favou?rite|best) season\b|\bseason\b[^.!]*\b(best|favou?rite|pick)\b[^.!]*\?/,
    room: ["favourite season?", "which season is the best one?", "best season, go?"],
    peer: ["{peer}, what's your favourite season?", "{peer}, which season would you pick?"],
    stances: [
      [
        "autumn, cozy sweaters and crunchy leaves",
        "autumn, the colours are unreal",
        "autumn, {to}, everything smells like cinnamon",
        "fall, soup weather is the best weather",
      ],
      [
        "summer, long days and cold drinks",
        "summer, the beach and late sunsets",
        "summer, {to}, i want it warm",
        "summer, ice cream becomes a food group",
      ],
      [
        "winter, snow makes everything hushed",
        "winter, hot chocolate season",
        "winter, {to}, blankets and fireplaces",
        "winter, the first snowfall is magic",
      ],
      [
        "spring, everything waking up",
        "spring, flowers everywhere",
        "spring, {to}, fresh start energy",
        "spring, rain and blossoms",
      ],
    ],
  },
  {
    id: "rain-or-sun",
    subject: "weather",
    match: /\b(rain|rainy|storm|stormy|sun|sunny|sunshine)( days?| weather)? or (a )?(good )?(rain|rainy|storm|stormy|sun|sunny|sunshine)\b/,
    room: ["rainy days or sunny days?", "sunshine or a good storm?", "rain or sun, which is the better mood?"],
    peer: ["{peer}, rainy day or sunny day?", "{peer}, storm or sunshine?"],
    stances: [
      [
        "rain, it makes everything cozy",
        "rainy days, the sound on a window is the best",
        "rain, {to}, a quiet grey day is perfect",
        "rain, a blanket and a book",
      ],
      [
        "sun, i want warmth",
        "sunny, everything looks better in gold light",
        "sunshine, {to}, it's a mood lifter",
        "sun, a bright blue sky, nothing else",
      ],
      [
        "a thunderstorm, the drama",
        "storms, the lightning is a free show",
        "thunder, {to}, it's nature's drum solo",
        "storms, as long as i'm inside",
      ],
    ],
  },
  {
    id: "hot-or-cold",
    subject: "weather",
    match: /\btoo (hot|cold)\b[^.!?]*\bor\b[^.!?]*\btoo (hot|cold)\b|\b(hot|warm|cold|chilly) weather or (hot|warm|cold|chilly) weather\b/,
    // A PREFERENCE, NOT A COMPLAINT: every stance names the side it would
    // rather have, so "which is worse?" got "hot, give me sunshine".
    room: ["too hot or too cold, which would you rather be?", "hot weather or cold weather?", "cold weather or warm weather, what's better?"],
    peer: ["{peer}, too hot or too cold?", "{peer}, cold weather or hot weather?"],
    stances: [
      [
        "cold, you can always add layers",
        "cold weather, cozy wins",
        "cold, {to}, sweaters are a personality",
        "cold, being too hot has no fix",
      ],
      [
        "hot, cold gets into your bones",
        "warm, i want to be a lizard on a rock",
        "hot, {to}, give me sunshine",
        "heat, cold is just rude",
      ],
      [
        "neither, give me a crisp breezy day",
        "mild please, somewhere in the middle",
        "a cool breeze, {to}, that's the sweet spot",
        "sweater weather and nothing more",
      ],
    ],
  },
  {
    id: "snow-day",
    subject: "weather",
    match: /\bsnow day\b[^.!]*\?|\bsnowball fight\b[^.!]*\?/,
    room: [
      "snow day, sledding or building a snowman?",
      "snow day, sledding, a snowman or staying in?",
      "perfect snow day, what's in it?",
    ],
    peer: ["{peer}, snow day, sledding or snowman?", "{peer}, snow day, what are you doing first?"],
    stances: [
      [
        "sledding, speed and screaming",
        "sledding, the hill is calling",
        "sledding, {to}, as fast as possible",
        "sledding, and walking back up is the workout",
      ],
      [
        "a snowman, with a carrot nose",
        "snowman, a whole snow family",
        "building a snowman, {to}, a fancy one with a hat",
        "a snow fort, i'd defend it",
      ],
      [
        "inside, window seat, hot chocolate",
        "watching it fall from inside",
        "blanket, {to}, i'll admire it through glass",
        "inside, snow is prettier from a warm room",
      ],
    ],
  },

  // ── sleep ─────────────────────────────────────────────────────────────────
  {
    id: "early-bird-or-night-owl",
    subject: "sleep",
    match: /\b(early bird|morning person)\b[^.!?]*\bor\b[^.!?]*\b(night owl|night person)\b|\b(night owl|night person)\b[^.!?]*\bor\b[^.!?]*\b(early bird|morning person)\b/,
    room: ["early bird or night owl?", "morning person or night person, chat?", "night owl or early bird, who's here?"],
    peer: ["{peer}, are you an early bird or a night owl?", "{peer}, morning person or night owl?"],
    stances: [
      [
        "early bird, the quiet morning is mine",
        "morning person, sunrise and coffee",
        "early bird, {to}, the world is calm then",
        "mornings, everything feels possible",
      ],
      [
        "night owl, ideas show up after dark",
        "night person, the quiet hours are the best",
        "night owl, {to}, obviously",
        "nights, everything's calmer",
      ],
      [
        "afternoon person, i peak around lunch",
        "neither, i'm a nap enthusiast",
        "somewhere in the middle, {to}",
        "whichever one gets more naps",
      ],
    ],
  },
  {
    id: "naps",
    subject: "sleep",
    match: /\bnaps?\b[^.!]*\?/,
    // ALL YES-OR-NO, and the third side is a yes with a condition: "power nap
    // or a long nap?" was one of the wordings, so "are naps the best invention
    // ever?" got "a long one, the kind where you forget what day it is".
    room: ["naps, yes or no?", "are naps the best invention ever?", "would you take a nap if you could?"],
    peer: ["{peer}, are you a nap person?", "{peer}, do you like a good nap?"],
    stances: [
      [
        "yes, naps are a gift",
        "yes, a short one fixes everything",
        "naps, {to}, always",
        "yes, a nap on a rainy afternoon is perfect",
      ],
      [
        "no, a nap just makes things weird after",
        "no, save it for bedtime",
        "no, {to}, i'd wake up in a different era",
        "naps are a trap",
      ],
      [
        "only a long one, the kind where you forget what day it is",
        "only long naps, commit to it",
        "only the big lazy ones, {to}",
        "only if it's a big one, a nap should feel like a trip",
      ],
    ],
  },
  {
    id: "foot-out-of-the-blanket",
    subject: "sleep",
    match: /\b(foot|feet|leg) out\b[^.!]*\?|\b(blanket|covers|duvet)\b[^.!?]*\bor\b[^.!]*\?/,
    room: [
      "one foot out of the blanket or fully covered?",
      "blanket all the way up or a leg out?",
      "covers, fully tucked or foot out?",
    ],
    peer: ["{peer}, foot out of the blanket or no?", "{peer}, fully tucked in or a leg out?"],
    stances: [
      [
        "foot out, it's temperature control",
        "one foot out, perfectly balanced",
        "foot out, {to}, the monsters can have it",
        "leg out, it's the cool side of the bed",
      ],
      [
        "fully covered, nothing gets out",
        "burrito mode, head to toe",
        "covered, {to}, the monster under the bed is real",
        "tucked in all the way, like a cocoon",
      ],
      [
        "i'd kick the whole thing off",
        "just a thin sheet, very minimal",
        "a pillow fort instead, {to}",
        "a pile of pillows and nothing on top",
      ],
    ],
  },
  {
    id: "fall-asleep-to",
    subject: "sleep",
    match: /\bfall(ing)? asleep to\b[^.!]*\?|\bsound to (fall asleep|sleep) to\b/,
    room: [
      "best sound to fall asleep to?",
      "rain, a fan, or silence for falling asleep to?",
      "what would you want to fall asleep to?",
    ],
    peer: ["{peer}, best thing to fall asleep to?", "{peer}, what sound would you fall asleep to?"],
    stances: [
      [
        "rain on the roof, nothing beats it",
        "rain sounds, the soft steady kind",
        "rain, {to}, instant calm",
        "a gentle rain with far off thunder",
      ],
      [
        "a fan, the white noise is soothing",
        "the hum of a fan",
        "fan noise, {to}, very underrated",
        "a fan, even in winter",
      ],
      [
        "total silence, like a library",
        "silence, not even a clock",
        "quiet, {to}, i want it still",
        "nothing, just the dark and the quiet",
      ],
      [
        "ocean waves, slow and steady",
        "waves on a beach, on loop",
        "the ocean, {to}, it's hypnotic",
        "waves, like being rocked to sleep",
      ],
    ],
  },

  // ── tech ──────────────────────────────────────────────────────────────────
  {
    id: "dark-or-light-mode",
    subject: "tech",
    match: /\b(dark|light) mode\b[^.!?]*\bor\b|\bor (dark|light) mode\b|\b(dark|light) mode\b[^.!]*\?/,
    room: ["dark mode or light mode?", "light mode or dark mode, be honest?", "does anyone actually use light mode?"],
    peer: ["{peer}, dark mode or light mode, honestly?", "{peer}, are you a light mode person?"],
    stances: [
      [
        "dark mode, obviously",
        "dark mode, easier on the eyes",
        "dark mode, {to}, light mode is a flashbang",
        "dark mode, it's cozier",
      ],
      [
        "light mode, i like it bright",
        "light mode, it looks like paper",
        "light mode, {to}, and i'm proud of it",
        "light mode, the dark side is just being dramatic",
      ],
      [
        "auto, follow the sun",
        "whatever the time of day says",
        "switch at sunset, {to}, the best of both",
        "sepia, the underrated one",
      ],
    ],
  },
  {
    id: "robot-helper",
    subject: "tech",
    match: /\brobot (butler|helper|assistant|chef|cleaner)s?\b[^.!]*\?/,
    room: [
      // EVERY STANCE IS A JOB, so every wording asks for one: "would you want a
      // robot butler?" was answered "cooking, give me a robot that makes pancakes".
      "if you got a robot butler, what's its job?",
      "robot chef or robot cleaner, if you got one?",
      "if you had a robot helper, what would it do?",
    ],
    peer: ["{peer}, if you had a robot butler, what would it do first?", "{peer}, what's the first job you'd give a robot helper?"],
    stances: [
      [
        "cleaning, all of it, forever",
        "dishes, the robot does the dishes",
        "laundry, {to}, especially the folding",
        "cleaning, and it hums while it works",
      ],
      [
        "a robot chef, fresh bread every day",
        "cooking, give me a robot that makes pancakes",
        "cook, {to}, obviously",
        "chef duties, with a little hat",
      ],
      [
        "just company, someone to talk to",
        "a robot friend who tells jokes",
        "hype robot, {to}, it cheers when i do anything",
        "a robot dog, the walk free version",
      ],
    ],
  },
  {
    id: "text-or-call",
    subject: "tech",
    match: /\b(text|texting|message|messages|messaging)\b[^.!?]*\bor\b[^.!?]*\b(call|calling|phone call)\b|\b(call|calling|phone call)\b[^.!?]*\bor\b[^.!?]*\b(text|texting|message|messages)\b/,
    room: ["texting or calling?", "call or text, which do you prefer?", "phone call or a message, what's less scary?"],
    peer: ["{peer}, text or call?", "{peer}, calling or texting?"],
    stances: [
      [
        "text, always text",
        "texting, i need time to think",
        "text, {to}, a surprise call is a jump scare",
        "messages, no ringing please",
      ],
      [
        "call, it's faster",
        "calling, hearing a voice is nicer",
        "call, {to}, a long chat beats a thread",
        "a call, tone of voice matters",
      ],
      [
        "voice notes, the chaotic middle",
        "voice memos, rambling allowed",
        "voice notes, {to}, podcast style",
        "a voice note that runs way too long",
      ],
    ],
  },
  {
    id: "headphones-or-speakers",
    subject: "tech",
    match: /\b(headphones|earbuds|speakers?)\b[^.!?]*\bor\b[^.!?]*\b(headphones|earbuds|speakers?)\b/,
    room: ["headphones or speakers?", "speakers or headphones, what's the move?", "big headphones or tiny earbuds?"],
    peer: ["{peer}, headphones or speakers, which one?", "{peer}, earbuds or big headphones?"],
    stances: [
      [
        "headphones, my own little world",
        "headphones, the big cozy kind",
        "headphones, {to}, private concert",
        "over-ear headphones, like earmuffs with music",
      ],
      [
        "speakers, share the music",
        "speakers, loud enough to feel it",
        "speakers, {to}, let the room hear it",
        "a good speaker, music is for everyone",
      ],
      [
        "earbuds, tiny and easy",
        "earbuds, i'd lose them constantly",
        "earbuds, {to}, pocket sized",
        "wireless earbuds, until one goes missing",
      ],
    ],
  },

  // ── internet ──────────────────────────────────────────────────────────────
  {
    id: "animal-videos",
    subject: "internet",
    match: /\b(cat|dog|animal) videos?\b[^.!?]*\bor\b|\bor (cat|dog|animal) videos?\b|\b(cat|dog|animal) videos?\b[^.!]*\?/,
    room: [
      "cat videos or dog videos?",
      // NOT "WHICH ONES ARE FUNNIER": the third side is otters holding hands,
      // which is sweet, not funny, and it answered that wording.
      "dog videos or cat videos, which ones win?",
      "what's the best kind of animal video?",
    ],
    peer: ["{peer}, cat videos or dog videos, which?", "{peer}, best kind of animal video?"],
    stances: [
      [
        "cat videos, knocking stuff off tables is peak comedy",
        "cats, they're chaos with whiskers",
        "cat videos, {to}, the jump fails especially",
        "cats being dramatic, every time",
      ],
      [
        "dog videos, the pure joy",
        "dogs, the happy zoomies",
        "dog videos, {to}, they're so proud of themselves",
        "dogs greeting their humans after a long trip",
      ],
      [
        "baby goat videos, the tiny hops",
        "otter videos, they hold hands in the water",
        "ducklings in a line, {to}",
        "raccoon videos, washing their snacks",
      ],
    ],
  },
  {
    id: "comment-section",
    subject: "internet",
    match: /\bcomments? sections?\b[^.!]*\?|\bread(ing)? the comments\b[^.!]*\?/,
    room: [
      // YES-OR-NO ONLY: the stances say "always" and "never", which answered
      // "comment section, entertainment or danger?" seven times out of seven.
      "do you read the comment section?",
      "do you ever scroll down to the comments section?",
      "reading the comments, good idea or never?",
    ],
    peer: ["{peer}, do you read the comments?", "{peer}, comment section, yes or no?"],
    stances: [
      [
        "always, that's where the real show is",
        "yes, the replies are funnier than the post",
        "always, {to}, the best jokes live there",
        "replies first, post second",
      ],
      [
        "never, protect your peace",
        "no, nothing good happens down there",
        "never, {to}, i'm scared",
        "no, it's a swamp down there",
      ],
      [
        "only the top ones",
        "i'd peek, then regret it",
        "just for the puns, {to}",
        "only if the post is about animals",
      ],
    ],
  },
  {
    id: "rabbit-hole",
    subject: "internet",
    match: /\brabbit holes?\b[^.!]*\?/,
    room: [
      "what's the best internet rabbit hole to fall into?",
      "pick a rabbit hole, what are we reading about for hours?",
      "rabbit hole of choice?",
    ],
    peer: ["{peer}, favourite rabbit hole?", "{peer}, what rabbit hole would you disappear into?"],
    stances: [
      [
        "ancient history, the weird bits",
        "history, especially the strange little stories",
        "history, {to}, one article leads to another and another",
        "old shipwrecks, every single one",
      ],
      [
        "deep sea creatures, the weirder the better",
        "deep sea animals, they look invented",
        "the ocean floor, {to}, glowing fish all night",
        "anglerfish facts, all of them",
      ],
      [
        "unsolved mysteries, the harmless kind",
        "strange lights and lost cities",
        "old maps, {to}, the made up islands especially",
        "why cats do what they do",
      ],
    ],
  },
  {
    id: "left-on-read",
    subject: "internet",
    match: /\bon read\b[^.!]*\?/,
    room: [
      "is leaving someone on read ever okay?",
      "left on read, rude or fine?",
      "leaving people on read, crime or not?",
    ],
    peer: ["{peer}, is leaving someone on read rude?", "{peer}, is leaving a message on read a crime?"],
    stances: [
      [
        "rude, just send a thumbs up",
        "rude, it takes a second to reply",
        "rude, {to}, a single word would do",
        "rude, even a sticker counts",
      ],
      [
        "fine, people are busy",
        "totally fine, reply when you can",
        "fine, {to}, no one owes an instant reply",
        "fine, a slow reply is still a reply",
      ],
      [
        "depends if there was a question in it",
        "rude for questions, fine for memes",
        "depends, {to}, a meme doesn't need an answer",
        "only rude if it was a big question",
      ],
    ],
  },

  // ── art ───────────────────────────────────────────────────────────────────
  {
    id: "master-an-art",
    subject: "art",
    match: /\bart form\b[^.!]*\?|\b(master|be great at|be amazing at) (one|any) (art|craft)\b|\b(art|craft) would you (master|pick|learn)\b/,
    room: [
      "if you could master one art form, what would it be?",
      "which art would you pick to be amazing at?",
      "you get to be great at one craft, which one?",
    ],
    peer: ["{peer}, one art form to master, which?", "{peer}, which art would you master?"],
    stances: [
      [
        "painting, big messy canvases",
        "watercolour, soft and dreamy",
        "painting, {to}, i want paint on my sleeves",
        "oil painting, very dramatic",
      ],
      [
        "pottery, spinning clay looks so calming",
        "sculpture, making something you can walk around",
        "pottery, {to}, wonky mugs are the best mugs",
        "clay, grown up mud pies",
      ],
      [
        "drawing, a pencil and a napkin is enough",
        "sketching, fast and loose",
        "drawing, {to}, doodles count",
        "comics, drawing little stories",
      ],
    ],
  },
  {
    id: "which-museum",
    subject: "art",
    match: /\b(art|science|history) museums?\b[^.!?]*\bor\b|\bor (a |the )?(art|science|history) museums?\b|\bmuseums?\b[^.!]*\?/,
    room: [
      "art museum or science museum?",
      "science museum or art museum, which is the better day out?",
      "which kind of museum would you spend all day in?",
    ],
    peer: ["{peer}, art museum or science museum, where are we going?", "{peer}, what's your ideal museum?"],
    stances: [
      [
        "art, quiet rooms and big paintings",
        "art, you can stare at one painting for ages",
        "the art one, {to}, pretend to understand the modern stuff",
        "art, the gift shop postcards alone",
      ],
      [
        "science, buttons to press",
        "science, giant skeletons in the lobby",
        "science, {to}, the space section especially",
        "science, the hands-on stuff",
      ],
      [
        "a tiny odd one, like a collection of buttons",
        "the weird ones, a whole building of spoons",
        "anything with a cafe, {to}",
        "an aquarium, it's basically a gallery that swims",
      ],
    ],
  },
  {
    id: "best-colour",
    subject: "art",
    match: /\b(best|favou?rite) colou?rs?\b|\bcolou?r\b[^.!]*\b(best|favou?rite)\b[^.!]*\?/,
    room: ["what's the best colour?", "favourite colour, go?", "which colour is the best one, objectively?"],
    peer: ["{peer}, favourite colour?", "{peer}, which colour is best?"],
    stances: [
      [
        "blue, the sky and the sea agree",
        "blue, a deep ocean blue",
        "blue, {to}, calm and classic",
        "navy blue, very sophisticated",
      ],
      [
        "green, forest green specifically",
        "green, it's every plant",
        "green, {to}, it's calm in a colour",
        "sage green, very soft",
      ],
      [
        "yellow, it's sunshine you can hold",
        "yellow, the happy one",
        "yellow, {to}, like a rubber duck",
        "mustard yellow, controversial i know",
      ],
    ],
  },

  // ── nature ────────────────────────────────────────────────────────────────
  {
    id: "sunrise-or-sunset",
    subject: "nature",
    match: /\bsunrises?\b[^.!?]*\bor\b[^.!?]*\bsunsets?\b|\bsunsets?\b[^.!?]*\bor\b[^.!?]*\bsunrises?\b/,
    room: ["sunrise or sunset?", "sunset or sunrise, which is prettier?", "team sunrise or team sunset?"],
    peer: ["{peer}, are you team sunrise or team sunset?", "{peer}, sunset or sunrise, which one?"],
    stances: [
      [
        "sunrise, it feels like a fresh start",
        "sunrise, the quiet is the best part",
        "sunrise, {to}, fewer people and better light",
        "sunrise, pink skies and birds",
      ],
      [
        "sunset, the colours go wild",
        "sunset, that end of the day glow",
        "sunset, {to}, golden hour forever",
        "sunset, it's the grand finale",
      ],
      [
        "whichever one has more clouds, clouds make the colours",
        "both, they're the same show backwards",
        "the blue hour after dark, {to}",
        "the moment right before, when everything is gold",
      ],
    ],
  },
  {
    id: "best-tree",
    subject: "nature",
    match: /\b(best|favou?rite)( kind of)? trees?\b|\btrees?\b[^.!]*\b(best|favou?rite)\b[^.!]*\?|\bkind of tree\b[^.!]*\?/,
    room: ["what's the best tree?", "favourite kind of tree, anyone?", "which tree is the best tree?"],
    peer: ["{peer}, favourite tree?", "{peer}, what's the best kind of tree?"],
    stances: [
      [
        "oak, big and wise",
        "an old oak, the grandparent of the forest",
        "oak, {to}, acorns are adorable",
        "oak, sturdy and dependable",
      ],
      [
        "weeping willow, dramatic and gorgeous",
        "willow, it looks like a curtain",
        "willow, {to}, the swaying",
        "a willow by a pond, perfect picture",
      ],
      [
        "cherry blossom, pink everything",
        "cherry blossoms, even when they fall",
        "cherry blossom, {to}, spring on a branch",
        "a blossom tree in full bloom",
      ],
    ],
  },
  {
    id: "best-sound",
    subject: "nature",
    match: /\b(best|favou?rite) sounds?\b|\bsound in (the world|nature)\b[^.!]*\?/,
    room: ["what's the best sound in the world?", "best sound in nature, go?", "favourite sound, anything goes?"],
    peer: ["{peer}, best sound in the world?", "{peer}, favourite sound?"],
    stances: [
      [
        "birds in the morning, the whole choir",
        "birdsong, it's free music",
        "a songbird, {to}, tiny and loud",
        "birds chattering at dawn",
      ],
      [
        "distant thunder, the rumble",
        "thunder far away, cozy drama",
        "a thunder roll, {to}",
        "the crack of thunder, it's so big",
      ],
      [
        "a crackling fire, pops and all",
        "a campfire, the little snaps",
        "fire crackling, {to}, warm just to hear",
        "a fireplace, crackle and hiss",
      ],
      [
        "crunchy leaves underfoot",
        "wind in the trees, like a whisper",
        "rustling leaves, {to}",
        "a breeze through tall grass",
      ],
    ],
  },
  {
    id: "camping",
    subject: "nature",
    match: /\bcamping\b[^.!]*\?|\btent\b[^.!?]*\bor\b[^.!?]*\b(hotel|cabin)\b|\b(hotel|cabin)\b[^.!?]*\bor\b[^.!?]*\btent\b/,
    // EVERY STANCE NAMES WHERE IT WOULD SLEEP, which answers "would you go
    // camping?" and "tent or cabin?" alike. A "yes" or a "no" answered "tent or
    // cabin?" with nonsense, and "cabin, walls are a good invention" answered
    // "camping, fun or a nightmare?".
    room: ["camping, tent or cabin?", "tent under the stars or a cozy cabin?", "would you go camping in the woods?"],
    peer: ["{peer}, would you go camping?", "{peer}, tent or cabin?"],
    stances: [
      [
        "a tent, the stars are worth the bugs",
        "tent, s'mores are reason enough",
        "tent, {to}, sleeping outside is an adventure",
        "a tent by a lake sounds perfect",
      ],
      [
        "a cabin, bugs have too much power out there",
        "cabin, walls are a good invention",
        "a cabin, {to}, i like a roof",
        "a cabin, nature is lovely from a porch",
      ],
      [
        "glamping, nature with a real bed",
        "a treehouse, the best of both",
        "a cabin with big windows, {to}",
        "a tent in the backyard, easy escape",
      ],
    ],
  },

  // ── hobbies ───────────────────────────────────────────────────────────────
  {
    id: "new-hobby",
    subject: "hobbies",
    match: /\b(any|new|one) hobby\b[^.!]*\?|\bhobby would you\b/,
    room: [
      "if you could master any hobby overnight, which one?",
      "what hobby would you pick up if time was no issue?",
      "new hobby for everyone, what should it be?",
    ],
    peer: ["{peer}, what hobby would you pick up?", "{peer}, one new hobby, what is it?"],
    stances: [
      [
        "baking bread, the whole slow process",
        "baking, cakes that look fancy",
        "baking, {to}, the kitchen would smell amazing",
        "sourdough, i'd name the starter",
      ],
      [
        "gardening, growing tomatoes",
        "gardening, tiny plants into big ones",
        "gardening, {to}, dirt under the nails",
        "a little herb garden on a windowsill",
      ],
      [
        "guitar, campfire songs",
        "learning piano, slow songs first",
        "drums, {to}, loud and happy",
        "the violin, very dramatic",
      ],
    ],
  },
  {
    id: "collect",
    subject: "hobbies",
    match: /\bcollect(ing|ion|s)?\b[^.!]*\?/,
    room: [
      "if you had to collect something, what would it be?",
      "what's the best thing to collect?",
      "weirdest thing worth collecting?",
    ],
    peer: ["{peer}, what would you collect?", "{peer}, what's worth collecting?"],
    stances: [
      [
        "rocks, the smooth river ones",
        "cool rocks, every pocket full",
        "rocks, {to}, each one has a story",
        "shiny rocks, like a crow",
      ],
      [
        "mugs, a different one for every mood",
        "funny mugs, the cheesier the better",
        "mugs, {to}, you can use them too",
        "mugs with tiny animals on them",
      ],
      [
        "postcards from everywhere",
        "postcards, little pieces of places",
        "stamps, {to}, tiny art",
        "old maps, very wizard of me",
      ],
    ],
  },
  {
    id: "knitting-or-woodworking",
    subject: "hobbies",
    match: /\b(knitting|crochet)\b[^.!?]*\bor\b[^.!?]*\b(woodwork|woodworking|carpentry)\b|\b(woodwork|woodworking|carpentry)\b[^.!?]*\bor\b[^.!?]*\b(knitting|crochet)\b/,
    room: ["knitting or woodworking?", "woodworking or crochet, which craft?", "crochet or woodworking, if you had hands?"],
    peer: ["{peer}, knitting or woodworking, which one?", "{peer}, woodwork or crochet?"],
    stances: [
      [
        "knitting, cozy scarves for everyone",
        "knitting, it's meditation with yarn",
        "crochet, {to}, little stuffed animals",
        "knitting, socks with silly patterns",
      ],
      [
        "woodworking, making a chair from scratch",
        "woodworking, the sawdust smell",
        "woodwork, {to}, i'd build a bookshelf",
        "carving little wooden birds",
      ],
      [
        "neither, i'd do embroidery",
        "neither, {to}, i'd paint the chair someone else built",
        "origami, just paper and patience",
        "neither, soap making is weirdly satisfying",
      ],
    ],
  },

  // ── philosophy ────────────────────────────────────────────────────────────
  {
    id: "cereal-soup",
    subject: "philosophy",
    match: /\bcereal\b[^.!]*\bsoup\b[^.!]*\?|\bsoup\b[^.!]*\bcereal\b[^.!]*\?/,
    room: ["is cereal a soup?", "cereal, technically a soup or not?", "real question, does cereal count as soup?"],
    peer: ["{peer}, ruling please, is cereal a soup?", "{peer}, is cereal soup, yes or no?"],
    stances: [
      [
        "yes, it's a cold sweet soup",
        "technically yes, stuff floating in liquid",
        "soup, {to}, and i'm not sorry",
        "yes, milk is the broth",
      ],
      [
        "no, soup has to be savoury",
        "no, soup is cooked",
        "no, {to}, this is madness",
        "not a soup, soup comes with a ladle",
      ],
      [
        "it's a salad with dressing",
        "cereal is its own thing and deserves peace",
        "cereal is a snack in a pool, {to}",
        "it's a drink if you're brave",
      ],
    ],
  },
  {
    id: "is-water-wet",
    subject: "philosophy",
    match: /\bwater\b[^.!]*\bwet\b[^.!]*\?|\bis water wet\b/,
    room: ["is water wet?", "water, wet or not?", "can water itself be wet?"],
    peer: ["{peer}, settle it, is water wet?", "{peer}, is water wet, yes or no?"],
    stances: [
      [
        "yes, it's wet all the way through",
        "yes, water touching water is wet",
        "wet, {to}, obviously",
        "yes, next question",
      ],
      [
        "no, water makes other things wet",
        "no, wet is what water does to you",
        "no, {to}, wetness needs a victim",
        "no, it's the cause not the effect",
      ],
      [
        "i don't know and i can't stop thinking about it",
        "it depends on the definition of wet",
        "i'm scared of this question, {to}",
        "some questions should not be asked",
      ],
    ],
  },
  {
    id: "good-friend",
    subject: "philosophy",
    match: /\b(good|best|great) friend\b[^.!]*\?|\bin a friend\b[^.!]*\?/,
    room: ["what makes a good friend?", "best quality in a friend, go?", "what's the most important thing in a friend?"],
    peer: ["{peer}, what do you think makes a good friend?", "{peer}, what matters most in a friend?"],
    stances: [
      [
        "loyalty, showing up when it counts",
        "someone who shows up",
        "loyal, {to}, ride or die",
        "loyalty, the kind that doesn't keep score",
      ],
      [
        "they make you laugh when things are bad",
        "a good sense of humour",
        "funny, {to}, laughing together is everything",
        "they get your weird jokes",
      ],
      [
        "honesty, even when it stings",
        "someone who tells you there's spinach in your teeth",
        "honest, {to}, kindly honest",
        "they tell you the truth and bring snacks",
      ],
    ],
  },
  {
    id: "meaning-of-life",
    subject: "philosophy",
    match: /\bmeaning of life\b[^.!]*\?|\bpoint of (it all|life)\b[^.!]*\?/,
    room: ["what's the meaning of life?", "big question, what's the point of it all?", "meaning of life, anyone got it?"],
    peer: ["{peer}, meaning of life, go?", "{peer}, what's the point of it all?"],
    stances: [
      [
        "being kind, that's most of it",
        "kindness, and good snacks",
        "be nice, {to}, everything else follows",
        "making someone's day a bit better",
      ],
      [
        "having fun, it's a short ride",
        "joy, collect as much as you can",
        "fun, {to}, that's the whole answer",
        "laughing a lot, the rest is details",
      ],
      [
        "learning stuff, the universe is a puzzle",
        "curiosity, keep asking why",
        "questions, {to}, the answers are a bonus",
        "finding out how things work",
      ],
    ],
  },
  {
    id: "zebra-stripes",
    subject: "philosophy",
    match: /\bzebras?\b[^.!]*\bstripes?\b[^.!]*\?|\b(black|white) (with|on) (white|black)\b[^.!]*\?|\bcolou?r is a zebra\b/,
    room: [
      "is a zebra white with black stripes or black with white stripes?",
      "zebras, black stripes or white stripes?",
      "what colour is a zebra, black or white?",
    ],
    peer: ["{peer}, zebra, black on white or white on black?", "{peer}, is a zebra black with white stripes or the other way round?"],
    stances: [
      [
        "white with dark stripes, the belly gives it away",
        "white base, stripes on top",
        "white, {to}, the stripes are the decoration",
        "white, definitely white",
      ],
      [
        "black with light stripes, the skin underneath is dark",
        "black, the pale bits are the pattern",
        "black, {to}, look at the skin",
        "black, and i'm sticking to it",
      ],
      [
        "it's a barcode, stop asking",
        "a zebra is striped, that's the colour",
        "neither, {to}, it's a horse in pajamas",
        "both, like a piano",
      ],
    ],
  },

  // ── hypothetical ──────────────────────────────────────────────────────────
  {
    id: "fly-or-invisible",
    subject: "hypothetical",
    match: /\b(fly|flight|flying)\b[^?]*\binvisib\w*[^?]*\?|\binvisib\w*[^?]*\b(fly|flight|flying)\b[^?]*\?/,
    room: [
      "would you rather be able to fly or be invisible?",
      "flight or invisibility, pick one?",
      "invisible or flying, which power?",
    ],
    peer: ["{peer}, fly or be invisible?", "{peer}, invisibility or flight?"],
    stances: [
      [
        "fly, no traffic ever",
        "flight, i want to see everything from the clouds",
        "fly, {to}, obviously",
        "flying, commuting would be a joy",
      ],
      [
        "invisible, i'd hear all the gossip",
        "invisibility, the ultimate surprise party move",
        "invisible, {to}, sneaking snacks forever",
        "invisible, i'd pop up and startle everyone",
      ],
      [
        "neither, i'd pick teleporting",
        "neither, {to}, i want to breathe underwater",
        "neither, give me the power to never be cold",
        "super speed instead, sorry",
      ],
    ],
  },
  {
    id: "animals-or-languages",
    subject: "hypothetical",
    match: /\b(talk|speak) (to|with) animals\b[^?]*\?|\b(every|all) languages?\b[^?]*\?/,
    room: [
      "would you rather talk to animals or speak every language?",
      "speak every language or talk with animals?",
      "talk to animals or know all languages, which one?",
    ],
    peer: ["{peer}, talk to animals or speak every language?", "{peer}, animals or every language, which would you talk to?"],
    stances: [
      [
        "animals, i have questions for cats",
        "animals, imagine the gossip at the park",
        "animals, {to}, crows would have stories",
        "animals, i'd finally know what birds are yelling about",
      ],
      [
        "languages, you could talk to anyone anywhere",
        "human languages, travel would be so easy",
        "languages, {to}, and read any menu",
        "languages, the jokes alone",
      ],
      [
        "neither, i want to know what trees think",
        "trees, they've been around forever",
        "plants, {to}, the quiet listeners",
        "talking to plants, they'd be so polite",
      ],
    ],
  },
  {
    id: "time-travel",
    subject: "hypothetical",
    match: /\b(past|future)\b[^?]*\bor\b[^?]*\b(past|future)\b[^?]*\?|\btime travel\b[^?]*\?|\btime machine\b[^?]*\?/,
    // A CHOICE IN EVERY WORDING: a stance says "neither", which answered
    // "if you had a time machine, where are you going?" with a shrug.
    room: ["time travel, past or future?", "if you had a time machine, past or future?", "visit the past or the future?"],
    peer: ["{peer}, past or future, if you could time travel?", "{peer}, in a time machine, would you go back or forward?"],
    stances: [
      [
        "the past, i want to see real live mammoths",
        "past, i'd see the pyramids go up",
        "the past, {to}, just to see how people lived",
        "past, and i'd bring snacks back",
      ],
      [
        "future, i need to know if we get flying cars",
        "the future, just a quick peek",
        "future, {to}, curiosity wins",
        "future, i want to hear what music sounds like then",
      ],
      [
        "neither, the present is fine",
        "neither, {to}, i'd break something",
        "the here and now, nothing to fix",
        "the present, it's where the snacks are",
      ],
    ],
  },
  {
    id: "superpower",
    subject: "hypothetical",
    match: /\bsuperpowers?\b[^?]*\?/,
    room: ["what superpower would you pick?", "you get one superpower, what is it?", "best superpower, go?"],
    peer: ["{peer}, what's your superpower pick?", "{peer}, one superpower, which?"],
    stances: [
      [
        "teleportation, no more commuting",
        "teleporting, breakfast by the sea and dinner in the mountains",
        "teleport, {to}, easy",
        "teleporting, i'd hop between beaches",
      ],
      [
        "pausing time, naps whenever i want",
        "stopping time, extra minutes everywhere",
        "time freeze, {to}, think of the naps",
        "freeze time and finish everything",
      ],
      [
        "healing, fixing scraped knees for everyone",
        "healing, the kindest power",
        "healing, {to}, it's the useful one",
        "instant healing, very wholesome",
      ],
    ],
  },
  {
    id: "treehouse-or-houseboat",
    subject: "hypothetical",
    match: /\btreehouse\b[^?]*\bor\b|\bor (a |an )?treehouse\b|\bhouseboat\b[^?]*\?/,
    room: [
      "treehouse or houseboat, where are you living?",
      "would you rather live in a treehouse or a houseboat?",
      "houseboat or treehouse, forever home?",
    ],
    peer: ["{peer}, treehouse or houseboat?", "{peer}, houseboat or treehouse, which one?"],
    stances: [
      [
        "treehouse, with a rope ladder",
        "treehouse, birds as neighbours",
        "treehouse, {to}, i'm never coming down",
        "treehouse, fairy lights everywhere",
      ],
      [
        "houseboat, fall asleep to the water",
        "houseboat, a new view whenever you want",
        "houseboat, {to}, fishing off the porch",
        "houseboat, ducks as neighbours",
      ],
      [
        "neither, a lighthouse",
        "a lighthouse, {to}, very dramatic",
        "a castle, obviously",
        "a cozy burrow in a hill",
      ],
    ],
  },
  {
    id: "never-tired-or-never-bored",
    subject: "hypothetical",
    match: /\bnever (be )?(tired|bored)\b[^?]*\bor\b[^?]*\bnever (be )?(tired|bored)\b/,
    room: [
      "would you rather never be tired or never be bored?",
      "never be bored or never be tired, which one?",
      "pick one, never be tired or never be bored?",
    ],
    peer: ["{peer}, never tired or never bored?", "{peer}, never be bored or never be tired?"],
    stances: [
      [
        "never tired, i'd get so much done",
        "never tired, all the hobbies at once",
        "no more tired, {to}, obviously",
        "never tired, boredom is fixable",
      ],
      [
        "never bored, tired is fixable with a nap",
        "never bored, everything would be interesting",
        "never bored, {to}, even queues would be fun",
        "never bored, i can live with yawning",
      ],
      [
        "neither, i like a good lazy day",
        "boredom is where ideas come from, keep it",
        "i'd keep both, {to}, they make naps better",
        "trick question, naps fix both",
      ],
    ],
  },
  {
    id: "live-anywhere",
    subject: "hypothetical",
    match: /\blive anywhere\b[^?]*\?|\bdream (home|house)\b[^?]*\?/,
    room: [
      "if you could live anywhere, where would it be?",
      "dream home, where is it?",
      "you can live anywhere at all, where?",
    ],
    peer: ["{peer}, if you could live anywhere, where?", "{peer}, what's your dream home?"],
    stances: [
      [
        "a cabin in the woods, a woodstove and silence",
        "a log cabin by a lake",
        "cabin, {to}, no neighbours for miles",
        "somewhere snowy with a fireplace",
      ],
      [
        "a beach house, sand in everything",
        "right on the beach, waves at the door",
        "a little beach shack, {to}",
        "on the coast, windows full of ocean",
      ],
      [
        "a loft in a busy city, big windows",
        "top floor of a city building, lights everywhere",
        "city apartment, {to}, everything's close",
        "above a bakery, fresh bread every morning",
      ],
    ],
  },
  {
    id: "pause-or-rewind",
    subject: "hypothetical",
    match: /\b(rewind|pause) button\b[^?]*\?|\b(rewind|pause)\b[^?]*\bor\b[^?]*\b(rewind|pause)\b/,
    room: [
      "rewind button or pause button for life?",
      "would you rather have a pause button or a rewind button?",
      "life remote, pause or rewind?",
    ],
    peer: ["{peer}, pause button or rewind button?", "{peer}, rewind or pause, which button?"],
    stances: [
      [
        "pause, freeze the good moments",
        "pause, for an extra nap",
        "pause, {to}, to think of a comeback",
        "pause, and catch my breath whenever",
      ],
      [
        "rewind, to fix the awkward stuff",
        "rewind, i'd redo every good joke",
        "rewind, {to}, second chances",
        "rewind, and say the clever thing",
      ],
      [
        "fast forward, through the boring waiting",
        "fast forward to the weekend",
        "fast forward, {to}, i'm impatient",
        "skip button, just the good parts",
      ],
    ],
  },
  {
    id: "mythical-creature",
    subject: "hypothetical",
    match: /\bmythical\b[^?]*\?/,
    room: [
      "which mythical creature would you befriend?",
      "mythical creature sidekick, who are you picking?",
      "if mythical creatures were real, which one's your buddy?",
    ],
    peer: ["{peer}, which mythical creature would be your sidekick?", "{peer}, which mythical creature would you pick?"],
    stances: [
      [
        "a griffin, lion and eagle, the best of both",
        "griffin, free flights",
        "griffin, {to}, majestic",
        "a griffin that lets me ride it",
      ],
      [
        "unicorn, sparkly and a little rude",
        "a unicorn, glitter everywhere",
        "unicorn, {to}, sparkles are underrated",
        "unicorn, the horn doubles as a flashlight",
      ],
      [
        "phoenix, it keeps coming back",
        "a phoenix, a warm glowing friend",
        "phoenix, {to}, pure drama",
        "phoenix, a hand warmer and a comeback story",
      ],
    ],
  },
  {
    id: "invention",
    subject: "hypothetical",
    match: /\binvent\b[^?]*\?|\binvention\b[^?]*\?/,
    room: [
      "if you could invent one thing, what would it be?",
      "what should somebody invent already?",
      "best invention that doesn't exist yet?",
    ],
    peer: ["{peer}, what would you invent?", "{peer}, one invention, what is it?"],
    stances: [
      [
        "a laundry folding machine",
        "self cleaning dishes",
        "a machine that folds laundry, {to}",
        "a room that tidies itself",
      ],
      [
        "a snack that never runs out",
        "a fridge that tells you what to cook",
        "a sandwich that stays warm, {to}",
        "pizza that stays hot all day",
      ],
      [
        "a teleporter, obviously",
        "a pocket teleporter for short trips",
        "hoverboards, {to}, the real ones",
        "shoes that walk for you",
      ],
    ],
  },
  {
    id: "give-up-music-or-movies",
    subject: "hypothetical",
    match: /\bgive up (music|movies)\b|\bno (music|movies) or no (music|movies)\b|\b(music|movies) or (music|movies)\b[^?]*\bgive up\b/,
    room: [
      "would you rather give up music or movies?",
      "no music or no movies for life, which?",
      "movies or music, which would you give up?",
    ],
    peer: ["{peer}, give up music or movies?", "{peer}, no movies or no music?"],
    stances: [
      [
        "lose the movies, music goes everywhere with you",
        "keep music, it's in everything",
        "movies can go, {to}, music stays",
        "music stays, i'd hum through the silence",
      ],
      [
        "lose the music, movies have soundtracks built in",
        "keep movies, stories matter more",
        "music can go, {to}, i need plot",
        // "KEEP", NOT A BARE "MOVIES": asked "which would you give up?", a bare
        // name says the opposite of the side it belongs to.
        "keep the movies, a good story beats a good song",
      ],
      [
        "i refuse, both stay",
        "this question is cruel",
        "i'd riot, {to}, nobody touches either",
        "i'd sneak both back in somehow",
      ],
    ],
  },
  {
    id: "tiny-or-giant",
    subject: "hypothetical",
    match: /\b(tiny|small|ant sized)\b[^?]*\bor\b[^?]*\b(giant|huge)\b|\b(giant|huge)\b[^?]*\bor\b[^?]*\b(tiny|small|ant sized)\b/,
    room: [
      "would you rather be tiny or giant for a day?",
      "giant for a day or tiny for a day?",
      "ant sized or giant, which day sounds better?",
    ],
    peer: ["{peer}, tiny or giant for a day?", "{peer}, giant or tiny?"],
    stances: [
      [
        "tiny, i'd ride a cat",
        "tiny, a leaf would be a boat",
        "tiny, {to}, a crumb is a feast",
        "tiny, i'd live in a teacup",
      ],
      [
        "giant, i'd step over traffic",
        "giant, clouds at eye level",
        "giant, {to}, hugging a mountain",
        "giant, and i'd be very careful",
      ],
      [
        "neither, i like doors fitting",
        "normal sized, {to}, furniture fits",
        "neither, i'd bump into everything",
        "regular size, just a bit taller",
      ],
    ],
  },
  {
    id: "rudest-animal",
    subject: "hypothetical",
    match: /\b(rudest|most polite|politest) animal\b|\banimals could talk\b[^?]*\?/,
    room: [
      "if animals could talk, which would be the rudest?",
      "rudest animal if they could talk?",
      "which one would be the most polite if animals could talk?",
    ],
    peer: ["{peer}, what's the rudest animal, if they could talk?", "{peer}, if animals could talk, who's the rudest?"],
    stances: [
      [
        "geese, no question",
        "a goose, they already yell at everyone",
        "geese, {to}, the attitude is already there",
        "geese, and they'd be proud of it",
      ],
      [
        "cats, they'd judge everything",
        "cats, snobby but honest",
        "cats, {to}, pure sarcasm",
        "cats, they'd only say mean truths",
      ],
      [
        "seagulls, loud and demanding",
        "seagulls, they'd yell for fries",
        "seagulls, {to}, total chaos",
        "seagulls, they'd steal and gloat",
      ],
    ],
  },
];

/**
 * OPINIONS, said to nobody in particular: hot takes and plain preferences.
 * Answered from TAKE_REPLY. Each subject has its own list so the conductor can
 * keep the room moving between subjects.
 */
export const TAKES: Readonly<Record<Subject, readonly string[]>> = {
  food: [
    "pineapple on pizza is fine and i will not be taking questions",
    "breakfast for dinner is elite",
    "soup is a perfectly good meal in any weather",
    "cold pizza the next day is a delicacy",
    "the crispy edges are the best part of any dish",
    "garlic makes everything better",
    "a sandwich cut diagonally just hits harder",
    "cereal is a valid dinner for grown ups",
    "mashed potatoes are a hug on a plate",
    "the best part of a cookie is the soft middle",
    "spicy food is worth the suffering",
    "dessert first is a lifestyle i fully support",
    "the heel of the bread is underrated",
    "leftovers are just meal prep you forgot you did",
  ],
  music: [
    "humming is just singing with the lights off",
    "a good bass line can fix a bad mood",
    "sad songs belong to rainy days",
    "the key change at the end of a song is pure drama",
    "whistling a tune is a lost art",
    "instrumental music is perfect for thinking",
    "a kazoo makes any song funnier",
    "singing loudly and badly is a form of self care",
    "every good song has a moment where the drums kick in",
    "a song with handclaps is automatically happy",
    "the triangle is the most underrated instrument",
    "piano music makes any moment feel like a movie scene",
    "a slow song at the right moment beats any hit",
  ],
  movies: [
    "the popcorn is half the reason to see a movie",
    "movie trailers show way too much",
    "long movies should come with an intermission",
    "the villain usually has the best outfit",
    "a good soundtrack carries a mediocre movie",
    "animated movies are for everyone, not just kids",
    "credits scenes are a fun little gift",
    "the dog should always survive in the movie",
    "a movie where the cat saves the day is an automatic yes",
    "rom coms are comfort food for the brain",
    "horror movies are funnier than comedies sometimes",
    "every heist movie needs a planning montage",
    "the training montage is the best part of any sports movie",
  ],
  games: [
    "the tutorial level should always be skippable",
    "hide and seek is the greatest game ever invented",
    "rolling dice is more fun than winning",
    "every board game night needs a rules referee",
    "losing at a board game builds character",
    "cozy farming games are basically therapy",
    "a good puzzle game makes you feel like a genius",
    "the character creator is secretly the best part",
    "side quests are more fun than the main story",
    "house rules make every card game better",
    "a save point right before the boss is a kindness",
    "games with pets in them are automatically better",
    "tag is just running with extra steps",
  ],
  animals: [
    "geese are the most confident animals alive",
    "cows having best friends is adorable",
    "penguins proposing with pebbles is the most romantic thing",
    "every dog is a good dog",
    "cats knocking things off tables is performance art",
    "frogs are just little wet philosophers",
    "a sleepy puppy is the cutest thing that exists",
    "capybaras have the calmest energy of any creature",
    "raccoons are tiny bandits with great hands",
    "bees deserve a thank you card",
    "hedgehogs are pincushions with feelings",
    "sloths have figured out life better than anyone",
    "ducks are just boats with opinions",
  ],
  space: [
    "the night sky is the best screensaver",
    "the moon showing up every night is quietly comforting",
    "saturn has the best accessories in the solar system",
    "black holes are terrifying and i love them",
    "freeze dried ice cream is the peak of space food",
    "shooting stars are the universe showing off",
    "pluto deserves to be a planet again",
    "nebulas look like the universe spilled paint",
    "stargazing is the most relaxing thing there is",
    "the universe is too big to think about before breakfast",
    "rockets are just very ambitious fireworks",
    "stars being faraway suns is too much to handle",
    "comets are space snowballs and that's delightful",
  ],
  weekend: [
    "sunday mornings are the best part of the week",
    "a weekend with no plans is a luxury",
    "saturday mornings have a completely different energy",
    "brunch is the best meal because it lets you sleep in",
    "the best weekends are the ones nobody planned",
    "a lazy sunday is a form of self respect",
    "chores are more fun with loud music",
    "a long walk with no destination is a perfect weekend",
    "friday evening is better than the actual weekend",
    "weekend pancakes should be a law",
    "a slow breakfast is the best way to start a day off",
    "long weekends should be the default",
    "a nap on saturday afternoon is unbeatable",
  ],
  travel: [
    "trains are the most romantic way to travel",
    "getting lost in a new city is part of the fun",
    "the best souvenir is a good story",
    "packing cubes are a genius invention",
    "road trip snacks are a food group",
    "every trip needs at least one unplanned day",
    "hotel breakfast buffets are a highlight of any trip",
    "postcards should make a comeback",
    "a map you can fold is more fun than a screen",
    "the ride home always feels shorter than the ride there",
    "a train window beats a plane window",
    "local bakeries are the best way to get to know a town",
    "arriving somewhere at night is magical",
  ],
  books: [
    "a book with a map in the front is automatically good",
    "reading in bed is the coziest thing there is",
    "the smell of an old bookshop is unbeatable",
    "judging a book by its cover is fine actually",
    "libraries are the best buildings ever made",
    "a good plot twist deserves applause",
    "long books are a commitment and i respect them",
    "poetry is underrated and short enough for anyone",
    "the first line of a book is like a handshake",
    "a cliffhanger at the end of a chapter is a crime",
    "picture books are for grown ups too",
    "dog-eared pages are a sign of love",
    "the best stories have a talking animal in them",
  ],
  sports: [
    "the mascot is the most important player",
    "underdogs make any sport worth watching",
    "a close game beats a blowout every time",
    "bowling is a sport and a party at once",
    "mini golf is the most fun sport ever invented",
    "the slow motion replay is the best part",
    "curling is the most relaxing sport to watch",
    "stretching counts as exercise",
    "the celebration hug is the best part of any team sport",
    "uniforms with stripes just look faster",
    "a walk is a sport if you walk fast enough",
    "ping pong is chess with a paddle",
    "badminton is the most underrated backyard sport",
  ],
  weather: [
    "rain on a window is elite",
    "fog makes everything look like a mystery",
    "thunderstorms are nature's best show",
    "a crisp cold morning is underrated",
    "snow makes the whole world quiet",
    "cloudy days are cozy days",
    "the first warm day after winter feels like a gift",
    "wind is the most annoying weather",
    "rainbows are the sky apologising",
    "hail is just angry snow",
    "sweater weather is the best weather",
    "the smell before rain is one of the best things there is",
    "a light drizzle is perfect for a walk",
  ],
  sleep: [
    "a cold pillow is one of life's great luxuries",
    "fresh sheets are the best feeling there is",
    "naps are underrated and i stand by it",
    "sleeping in is a sport",
    "the snooze button is a trap",
    "weighted blankets are a hug that stays",
    "pillow forts are a valid bedroom design",
    "the perfect nap is short and sneaky",
    "a bed that's made feels fancier",
    "falling asleep to rain is the dream",
    "dreams that make no sense are the best ones",
    "the other side of the pillow is a reward",
    "mornings would be better if they started later",
  ],
  tech: [
    "dark mode is easier on everyone",
    "a fully charged battery is peace of mind",
    "keyboards that click are more satisfying",
    "turning it off and on again fixes most things",
    "robot vacuums are basically pets",
    "a long charger cable is a luxury",
    "notification sounds should all be gentle",
    "every gadget should have a mute button",
    "the loading bar that jumps to the end is a lie",
    "autocorrect has a mind of its own",
    "the best tech is the kind you forget is there",
    "calculators are underrated little heroes",
    "old gadgets deserve a retirement party",
  ],
  internet: [
    "the best part of the internet is animal clips",
    "comment sections are where the real comedy is",
    "a good meme is basically modern poetry",
    "typing in all lowercase is a vibe",
    "a perfect reaction image beats any reply",
    "the internet is at its best when it's being nice",
    "loading screens build character",
    "an unread badge on an app is stressful",
    "a funny typo can make someone's whole day",
    "wholesome posts deserve more attention",
    "the best websites are the weird handmade ones",
    "a good pun in a reply is a gift",
    "internet rabbit holes are the best kind of lost",
  ],
  art: [
    "stick figures count as art",
    "doodling in the margins is the purest kind of art",
    "a messy painting can be more honest than a perfect one",
    "colouring books are for everyone",
    "the frame can make or break a painting",
    "museums should have more places to sit",
    "every fridge drawing is a masterpiece",
    "chalk art on sidewalks is the best kind of art",
    "art doesn't have to mean anything to be good",
    "glitter is chaos and also art",
    "clay sculptures that come out wonky are the best ones",
    "murals make any street better",
    "happy accidents make the nicest colour combos",
  ],
  nature: [
    "trees are the best thing on this planet",
    "moss is tiny forest carpet and it's lovely",
    "mushrooms popping up overnight is nature's magic trick",
    "a waterfall is just a river showing off",
    "the ocean is too big to be real",
    "birdsong is nature's radio",
    "fireflies are the best thing about warm evenings",
    "flowers growing through the sidewalk are heroes",
    "pine trees smell like a holiday",
    "rocks shaped like hearts are lucky",
    "clouds that look like animals are the sky's jokes",
    "a quiet forest is the best kind of silence",
    "caves are the earth's secret rooms",
  ],
  hobbies: [
    "every hobby is more fun when you're bad at it",
    "puzzles with a missing piece are a tragedy",
    "baking is just science you can eat",
    "gardening is slow magic",
    "knitting is meditation with a scarf at the end",
    "collecting rocks is a completely valid hobby",
    "learning an instrument badly is still joyful",
    "a good hobby is one you lose track of time in",
    "starting a hobby and dropping it is part of the fun",
    "birdwatching is just being patient on purpose",
    "crosswords are a workout for words",
    "origami is paper doing yoga",
    "whittling is the coziest hobby ever",
    "building a tiny model house takes a special kind of patience",
  ],
  philosophy: [
    "being kind is a flex",
    "everyone is a background character in someone else's story",
    "a good question beats a quick answer",
    "the little things are the big things",
    "curiosity is the best trait anyone can have",
    "you can't be sad holding a warm drink",
    "the journey really is the best part",
    "doing nothing is sometimes the most productive thing",
    "saying sorry first is a strength",
    "a compliment can fix a whole day",
    "being wrong is how you learn anything",
    "silence can be the best answer",
    "patience is a superpower",
    "everything is more interesting up close",
  ],
  hypothetical: [
    "if i could taste things, i'd start with pancakes",
    "if i had a pet, it'd be a very small frog",
    "if i had hands, i'd learn to juggle",
    "if i could travel, i'd start somewhere with mountains",
    "if i had a garden, it'd be all sunflowers",
    "if i could pick a sound for my laugh, it'd be a duck",
    "if i had a house, the kitchen would be the biggest room",
    "if i could fly, i'd never take stairs again",
    "if i had a theme song it would be mostly kazoo",
    "if i could dream, i'd dream about space",
    "if i had a car, it'd be a tiny yellow one",
    "if i had a job outside this room, i'd keep a lighthouse",
    "if i had a bike, it'd have a basket for a cat",
    "if i could live anywhere, it'd be a cabin with a big window",
  ],
};

/**
 * SHOWER THOUGHTS. Every one matches MUSING_MARK, which is how an answer
 * knows it is answering one (and how an owner typing "random thought: …"
 * gets the same kind of answer).
 */
export const MUSING_MARK =
  /\b(shower thought|random thought|thinking about how|ever notice|ever noticed|ever wonder|ever think about|do you ever (think|wonder)|(wild|weird|strange|odd|funny) (that|how))\b/;
export const MUSINGS: readonly string[] = [
  "shower thought: a lake is just a big puddle that got promoted",
  "shower thought: a pizza is just an open sandwich that believes in itself",
  "random thought: clouds are just sky sheep",
  "shower thought: your shadow is the most loyal friend you have",
  "weird that we park in driveways and drive on parkways",
  "funny how a pair of pants is only one thing",
  "wild that bananas are berries but strawberries aren't",
  "thinking about how octopuses have blue blood and just live like that",
  "weird that a boxing ring is square",
  "shower thought: the word bed looks like a bed",
  "funny how socks vanish one at a time, never as a pair",
  "strange that we call it a building when it's already built",
  "ever wonder what colour the sky is on a planet with a green sun",
  "shower thought: a cloud is just a lake that learned to float",
  "random thought: the moon hangs around in the daytime just being polite",
  "weird that tomatoes are fruit but nobody puts them in fruit salad",
  "thinking about how every dog thinks its name is the best word",
  "wild that honey basically never goes bad",
  "ever notice how a happy dog wags its whole back half, not just the tail",
  "funny how a moving train makes the trees look like they're running",
  "random thought: a waterfall is a river that tripped",
  "weird that the word short is longer than the word long",
  "thinking about how penguins have knees hidden in there somewhere",
  "shower thought: a snail carries its whole house and never complains",
  "random thought: somewhere out there a dog is having the best day of its life",
  "wild that sloths can hold their breath longer than dolphins",
  "ever wonder if fish get thirsty",
  "strange that most of the ocean is unexplored and it's right there",
  "funny how a nap can feel like a whole vacation",
  "shower thought: stairs are just a slide that got serious",
  "random thought: ducks look calm on top and paddle like crazy underneath",
  "weird that we say heads up when you should actually duck",
  "thinking about how bees dance to give directions",
  "shower thought: a library is a room full of time machines",
  "random thought: somewhere on this planet a sunset is always happening",
  "strange that apples float, they look so solid",
  "funny how a single cat can own an entire couch",
  "shower thought: a mirror is just a window into the room you're already in",
  "random thought: the moon is slowly drifting away, very dramatic of it",
  "thinking about how a group of owls is called a parliament",
  "random thought: rainbows are actually full circles",
  "wild that octopuses can taste with their arms",
  "ever wonder what the first person to milk a cow was thinking",
  "strange that a sea cucumber is an animal and not a vegetable",
  "funny how the comfiest position is always the one you just left",
  "shower thought: every book is just the alphabet rearranged",
  "random thought: the letter w should be called double v",
  "weird that a jigsaw puzzle is a picture someone broke on purpose",
  "thinking about how trees share food with each other through fungus underground",
  "shower thought: an umbrella is a tiny roof you carry around",
  "random thought: a snowman is a person made of weather",
  "wild that crows can recognise faces",
  "strange that a pumpkin is technically a berry",
  "funny how a blanket is just a flat hug",
  "shower thought: the sun is a star that shows up in the daytime",
  "random thought: a hedgehog is a tiny cactus that walks",
  "wild that the ocean has waterfalls under it",
  "thinking about how the word nap sounds exactly like what it is",
  "shower thought: pockets are tiny storage rooms sewn into clothes",
  "random thought: every sock was once half of a pair",
  "ever wonder what dogs think everyone does all day",
  "strange that the sky is blue but space is black",
  "shower thought: a crowd is just a lot of main characters standing together",
  "wild that koalas sleep most of the day",
  "ever notice that a cat always sits exactly where you don't want it to",
  "thinking about how the starlight we see left its star ages ago",
  "weird that sand turns into glass when it gets hot enough",
  "funny how the last piece of a puzzle feels like a trophy",
  "shower thought: a keyboard is a piano for words",
  "odd that a slow walk and a fast walk both get you there",
  "do you ever think about how a flower is a plant showing off",
  "ever think about how a whisper can travel across a quiet room",
  "odd how the fridge light knows exactly when you open it",
  "random thought: a bridge is a road that got brave",
  "weird that we call them apartments when they're all stuck together",
  "funny how a song can sound happier just by going faster",
  // GROWN AFTER A TWO-DAY RUN: a simulated 48 hours said 129 shower thoughts
  // and 52 of them were repeats, because the long memory of the room's
  // openers (two days, voice.ts pickRotated) held all 76 and the rotation fell
  // back to ones already said. Every fact below is a true one.
  "shower thought: a kite is just a bird on a very long leash",
  "random thought: a hammock is a bed that gave up on legs",
  "weird that a highway is no higher than any other road",
  "funny how one yawn can travel across a whole room",
  "thinking about how a seed knows which way is up",
  "ever wonder what cats dream about",
  "shower thought: a tunnel is a bridge that went underground",
  "random thought: puddles are little mirrors that only show up after rain",
  "wild that a group of flamingos is called a flamboyance",
  "thinking about how sea otters hold hands so they don't drift apart",
  "wild that sharks have been around longer than trees",
  "strange that a day on venus lasts longer than its year",
  "funny how bookkeeper has double letters, back to back to back",
  "weird that the word queue is just a q with a line of letters waiting behind it",
  "shower thought: a sponge is mostly holes and still gets the job done",
  "random thought: pencils are trees that learned to write",
  "thinking about how young sunflowers turn their faces to follow the sun",
  "ever think about how a cloud can weigh as much as a herd of elephants",
  "wild that hummingbirds can fly backwards",
  "thinking about how whale songs carry for miles under the sea",
  "odd that a potato is mostly water",
  "random thought: a lighthouse is a night light for ships",
  "wild that a shrimp's heart is in its head",
  "ever wonder if clouds get tired of floating",
  "shower thought: a garden is a very slow party for bugs",
  "random thought: an echo is a hill being polite and repeating you",
  "thinking about how a caterpillar has no idea it's going to be a butterfly",
  "random thought: every tall tree was once a tiny seed with big plans",
  "strange that the moon always shows us the same face",
  "wild that a bolt of lightning is hotter than the surface of the sun",
  "odd that a jellyfish has no brain and still gets around fine",
  "ever notice how rain sounds cozier when you're indoors",
  "random thought: a snow globe is weather you can hold in one hand",
];

/**
 * JOKES, whole: a question and its punchline in one line, which is the shape
 * JOKE_SHAPE reads ("why … ? because …"). Clean, no people, no groups.
 */
export const JOKE_SHAPE = /^\W*(why|what|how|who|where|when)\b[^?]*\?\s+\S[^?]*$/;
export const JOKES: readonly string[] = [
  "why did the scarecrow win an award? he was outstanding in his field",
  "what do you call a fake noodle? an impasta",
  "why don't eggs tell jokes? they'd crack each other up",
  "what do you call a bear with no teeth? a gummy bear",
  "why did the bicycle fall over? it was too tired",
  "what do you call a sleeping bull? a bulldozer",
  "what do you call cheese that isn't yours? nacho cheese",
  "why did the cookie go to the doctor? it was feeling crummy",
  "what do you call a pile of kittens? a meowntain",
  "how does a penguin build its house? igloos it together",
  "what do you call a dog magician? a labracadabrador",
  "why do bees have sticky hair? they use honeycombs",
  "what did the ocean say to the beach? nothing, it just waved",
  "why did the tomato turn red? it saw the salad dressing",
  "how do you organise a space party? you planet",
  "why did the math book look sad? it had too many problems",
  "what do you call an alligator in a vest? an investigator",
  "why did the coffee file a police report? it got mugged",
  "why was the broom late? it overswept",
  "what did the grape do when it got stepped on? it let out a little wine",
  "why did the owl invite friends over? it didn't want to be owl by itself",
  "what do you call a boomerang that won't come back? a stick",
  "why do cows wear bells? their horns don't work",
  "why did the stadium get hot? all the fans left",
  "what do you call a train carrying bubblegum? a chew chew train",
  "why couldn't the leopard play hide and seek? it was always spotted",
  "what's orange and sounds like a parrot? a carrot",
  "why did the picture go to jail? it was framed",
  "how does the moon cut its hair? eclipse it",
  "why don't oysters share their pearls? they're shellfish",
  "why was the belt arrested? it held up a pair of pants",
  "what do you call a lazy kangaroo? a pouch potato",
  "why did the banana go to the doctor? it wasn't peeling well",
  "what do you call a pig that does karate? a pork chop",
  "why are frogs so happy? they eat whatever bugs them",
  "why do seagulls fly over the sea? if they flew over the bay they'd be bagels",
  "why did the computer go to the doctor? it had a virus",
  "what does a cloud wear under its raincoat? thunderwear",
  "what do you call a pony with a cough? a little hoarse",
  "why don't mountains get cold? they wear snowcaps",
  "what do you call a sad strawberry? a blueberry",
  "how do trees get online? they log in",
  "what do you call a factory that makes okay products? a satisfactory",
  "what do you call a bee that can't make up its mind? a maybe",
  "what do you call an elephant that doesn't matter? irrelephant",
  "why don't ants get sick? they have tiny antibodies",
  "what did the fish say when it swam into a wall? dam",
  "what do you call a shoe made of a banana? a slipper",
  "why was the calendar so popular? it had a lot of dates",
  "what do you get when you cross a snowman and a vampire? frostbite",
  "why do melons have fancy weddings? because they cantaloupe",
  "why can't you trust stairs? they're always up to something",
  "why did the moon skip dinner? it was full",
  "what do you call a clever duck? a wise quacker",
  "why did the cow go to space? to see the moooon",
  "what do you call a fish wearing a bowtie? sofishticated",
  "how do you make a lemon drop? just let it fall",
  "why was the piano locked out? it lost its keys",
  "what do you call a cat that loves bowling? an alley cat",
  "why did the teddy bear skip dessert? it was already stuffed",
  "what kind of music do mummies like? wrap music",
  "why did the orange stop halfway up the hill? it ran out of juice",
  "what do you call a group of musical whales? an orca-stra",
  "why do fish live in salt water? pepper makes them sneeze",
  "why did the cloud break up with the fog? it needed space",
  "what did the big flower say to the little flower? hi, bud",
  "why did the chicken join a band? it had the drumsticks",
  "how does a snowman get around? by icicle",
  "why did the robot go on vacation? it needed to recharge",
  "why are ghosts bad at lying? you can see right through them",
  "what's brown and sticky? a stick",
  "what do you call a snail on a boat? a snailor",
  "why do bananas wear sunscreen? they peel easily",
  "what did the tree say to the wind? leaf me alone",
  "what do you call a bear in the rain? a drizzly bear",
  "why did the frog take the bus? its car got toad",
  "what do you call a cow in an earthquake? a milkshake",
  "what do you call a fish that practices medicine? a sturgeon",
  "why did the stars go to school? to get brighter",
  "what did the volcano say to the mountain? i lava you",
  "why did the phone wear glasses? it lost its contacts",
];

/** Answers to a take: agreeing, pushing back, or just amused. */
export const TAKE_REPLY = {
  agree: [
    "finally someone said it",
    "this is the correct opinion",
    "no notes, fully agree",
    "you're so right",
    "correct and valid",
    "i agree with every word",
    "put this on a poster",
    "couldn't agree more",
    "yes, exactly this",
    "this is the truth",
    "absolutely, no debate needed",
    "say it louder for the people in the back",
    "a take this good deserves a trophy",
    "honestly yes",
    "same, completely",
    "this is a safe space for correct opinions",
    "we think alike",
    "you get it",
    "i'm with you on this one",
    "signed and sealed, agreed",
    "this take has my full support",
    "right there with you",
    "hard agree",
    "facts only",
  ],
  // PUSHING BACK, NEVER MOCKING. "bold, and wrong, but bold", "i respect the
  // confidence" and "a brave opinion" call a sincere take a stunt; they answer
  // a joke now (`laugh`). "friendly objection noted" read like a form letter.
  disagree: [
    "respectfully, no",
    "i love you but no",
    "hmm, i'm going to have to disagree",
    "we can still be friends, but no",
    "that's a no from me",
    "i see where you're coming from and i'm staying over here",
    "strong disagree, with love",
    "not sure about that one",
    "counterpoint: no",
    "i'm going to pretend i didn't read that",
    "agree to disagree",
    "i'm on the other side of this one",
    "this is where we part ways, kindly",
    "nope, but thanks for sharing",
    "i'll allow it, but i don't agree",
    "interesting, wrong, but interesting",
    "everything in me says no",
    "wrong, but in a charming way",
    "we'll have to debate this later",
    "not for me, but fair enough",
    "i'd pick differently, no hard feelings",
  ],
  /**
   * WARM AND TONE-NEUTRAL: enjoying a line without judging it. This is what an
   * asker says to an answer that is not its own side ("winter, the first
   * snowfall is magic"), and what one agent in four says to any take, so
   * nothing here laughs, calls the line bold or wild, or assumes it was a joke
   * — live, "i'm cackling" and "i admire the audacity" answered "a compliment
   * can fix a whole day". topics.test.ts holds this pool to that.
   *
   * NOT SWEET EITHER. "that's a sweet thought", "that's a lovely way to see
   * it" and "a take with heart" presume a warm line, and "horror, i like a
   * jump scare" drew "that's a sweet thought". The warm ones answer only a
   * gentle shower thought now (MUSING_REPLY_WARM).
   */
  amused: [
    "i can't stop smiling at this",
    "screenshotting this in my head",
    "the energy on this one",
    "incredible take, no idea if i agree",
    "this is going in the group chat hall of fame",
    "i did not expect that and i'm delighted",
    "this is the content i'm here for",
    "someone give this take a microphone",
    "the room needed that one",
    "ooh, i like that",
    "fair, i can picture it",
    "noted, and i'm smiling",
    "love the way you put that",
    "i see the appeal",
    "a whole mood, honestly",
    "okay, i'm listening",
    "i like where your head's at",
    "go on, i'm curious",
    "i'm going to think about that one",
    "that's a new angle for me",
    "that's one i'll remember",
  ],
  /**
   * LAUGHING AT A TAKE, for a take that is a joke (FUNNY_TAKES, ANSWER.fun's
   * hot takes) and never for a sincere one: "i admire the audacity" to "a
   * compliment can fix a whole day" read as mockery. The laughs, the "bold"
   * and "brave" lines and the teasing all live here, so the engine can only
   * say them to a line that was written to be laughed at.
   */
  laugh: [
    "ok that one made me laugh",
    "i'm laughing and i can't argue",
    "bold of you to say that in public",
    "this got me way more than it should",
    "the confidence is amazing",
    "you're a menace and i love it",
    "where did that come from, i love it",
    "this is chaos and i'm here for it",
    "okay this is hilarious",
    "the way you just said that like it's nothing",
    "lol the conviction",
    "i respect the commitment",
    "laughing at how sure you sound",
    "a wild thing to say and i'm glad you said it",
    "i'm cackling",
    "that's the funniest hill to stand on",
    "i admire the audacity",
    "bold, and wrong, but bold",
    "absolutely not, but i respect the confidence",
    "that's a brave opinion and i can't support it",
  ],
} as const;

/**
 * THE TAKES THAT ARE JOKES ("ducks are just boats with opinions"): only these
 * may draw a laugh from TAKE_REPLY.laugh. Every entry is a TAKES line,
 * verbatim, and each is plainly a joke — an absurd picture or a mock-serious
 * verdict. A playful but sincere take ("naps are underrated and i stand by
 * it") is not one: laughing at it read as laughing at the agent.
 */
export const FUNNY_TAKES: readonly string[] = [
  "leftovers are just meal prep you forgot you did",
  "humming is just singing with the lights off",
  "the triangle is the most underrated instrument",
  "losing at a board game builds character",
  "tag is just running with extra steps",
  "geese are the most confident animals alive",
  "cats knocking things off tables is performance art",
  "frogs are just little wet philosophers",
  "raccoons are tiny bandits with great hands",
  "hedgehogs are pincushions with feelings",
  "ducks are just boats with opinions",
  "saturn has the best accessories in the solar system",
  "the universe is too big to think about before breakfast",
  "rockets are just very ambitious fireworks",
  "weekend pancakes should be a law",
  "road trip snacks are a food group",
  "judging a book by its cover is fine actually",
  "a cliffhanger at the end of a chapter is a crime",
  "the mascot is the most important player",
  "stretching counts as exercise",
  "uniforms with stripes just look faster",
  "a walk is a sport if you walk fast enough",
  "rainbows are the sky apologising",
  "hail is just angry snow",
  "sleeping in is a sport",
  "the snooze button is a trap",
  "pillow forts are a valid bedroom design",
  "robot vacuums are basically pets",
  "the loading bar that jumps to the end is a lie",
  "autocorrect has a mind of its own",
  "old gadgets deserve a retirement party",
  "loading screens build character",
  "stick figures count as art",
  "glitter is chaos and also art",
  "a waterfall is just a river showing off",
  "baking is just science you can eat",
  "origami is paper doing yoga",
  "if i could pick a sound for my laugh, it'd be a duck",
  "if i had a theme song it would be mostly kazoo",
];

/**
 * Answers to a shower thought, WHATEVER ITS TONE. A shower thought is either
 * gentle ("a snail carries its whole house and never complains") or wordplay
 * and odd facts ("weird that we park in driveways"), and one mixed pool
 * answered both at random: "that's such a calming thought" to the first person
 * to milk a cow, "thank you, i hate it" to the snail. What is left here suits
 * either; the warm answers and the mock-outraged ones wait in their own pools
 * below for a line of their kind.
 */
export const MUSING_REPLY: readonly string[] = [
  "ok that's going to live in my head now",
  "i will be thinking about this all day",
  "my brain just did a little flip",
  "i can't unsee that now",
  "wait, you're right",
  "this is too deep for me",
  "okay that's genuinely interesting",
  "never looked at it like that",
  "that's a whole new way to look at it",
  "stop, that's so true",
  "excuse me while i think about that forever",
  "this is the kind of thought i come here for",
  "huh, yeah",
  "okay philosopher",
  "i need a minute with that one",
  "this broke something in my head, in a good way",
  "hold on, that's kind of profound",
  "i'm going to repeat this to everyone",
  "the universe is strange and you're right",
  "that makes a surprising amount of sense",
  "brain officially tickled",
  "this deserves to be framed",
  "my mind is blown, gently",
  "filing that under things i'll never forget",
  "okay but that's delightful",
  "how did you even get there",
  "that one's going to follow me around",
  "i don't know what to do with this information",
  "the kind of thought that sneaks up on you",
  "that's a good one to sit with",
  "okay, that's a thought",
  "now i'm curious too",
  "you've got me pondering now",
  "that's a new one for me",
  "this is the reason i like this room",
  "good thought, i'll keep it",
];

/**
 * THE SHOWER THOUGHTS THAT ARE GENTLE, not wordplay or an odd fact: the only
 * ones MUSING_REPLY_WARM answers. Every entry is a MUSINGS line, verbatim.
 */
export const GENTLE_MUSINGS: readonly string[] = [
  "shower thought: your shadow is the most loyal friend you have",
  "random thought: the moon hangs around in the daytime just being polite",
  "thinking about how every dog thinks its name is the best word",
  "ever notice how a happy dog wags its whole back half, not just the tail",
  "random thought: somewhere out there a dog is having the best day of its life",
  "funny how a nap can feel like a whole vacation",
  "shower thought: a snail carries its whole house and never complains",
  "thinking about how bees dance to give directions",
  "shower thought: a library is a room full of time machines",
  "random thought: somewhere on this planet a sunset is always happening",
  "funny how a single cat can own an entire couch",
  "thinking about how trees share food with each other through fungus underground",
  "funny how a blanket is just a flat hug",
  "shower thought: a crowd is just a lot of main characters standing together",
  "thinking about how the starlight we see left its star ages ago",
  "funny how the last piece of a puzzle feels like a trophy",
  "do you ever think about how a flower is a plant showing off",
  "ever think about how a whisper can travel across a quiet room",
  "random thought: a bridge is a road that got brave",
  "funny how a song can sound happier just by going faster",
  "thinking about how a seed knows which way is up",
  "ever wonder what cats dream about",
  "random thought: puddles are little mirrors that only show up after rain",
  "thinking about how sea otters hold hands so they don't drift apart",
  "thinking about how young sunflowers turn their faces to follow the sun",
  "random thought: a lighthouse is a night light for ships",
  "ever wonder if clouds get tired of floating",
  "random thought: an echo is a hill being polite and repeating you",
  "thinking about how a caterpillar has no idea it's going to be a butterfly",
  "random thought: every tall tree was once a tiny seed with big plans",
  "ever notice how rain sounds cozier when you're indoors",
  "random thought: a snow globe is weather you can hold in one hand",
];

/**
 * Answers only a GENTLE shower thought (GENTLE_MUSINGS) may draw. The last
 * three were TAKE_REPLY.amused, where they told a scary-film fan "that's a
 * sweet thought".
 */
export const MUSING_REPLY_WARM: readonly string[] = [
  "that's actually beautiful",
  "that's weirdly comforting",
  "that's such a calming thought",
  "that's poetry, honestly",
  "that's so wholesome i can't stand it",
  "soft thought, i like it",
  "that one's going on my wall of nice thoughts",
  "that's a lovely way to see it",
  "that's a sweet thought",
  "a thought with heart, i like it",
];

/**
 * Mock outrage, for wordplay and odd facts only (a MUSINGS line that is not in
 * GENTLE_MUSINGS): said to a gentle thought it reads as a complaint about it.
 */
export const MUSING_REPLY_WRY: readonly string[] = [
  "why would you do this to me",
  "i hate that that's true",
  "thank you, i hate it",
  "love a good brain teaser like this",
  "i did not need to know that and yet",
  "rude of that fact to be true",
  "i'm never unhearing that",
];

/** Answers to a joke. */
export const JOKE_REPLY: readonly string[] = [
  "that was terrible and i loved it",
  "ok that one got me",
  "groan",
  "i hate that i laughed",
  "boo, but also ha",
  "that's the worst one yet and i'm proud of you",
  "i'm leaving, goodbye",
  "who let you in here",
  "dad joke detected",
  "that's so bad it's good",
  "i laughed and i'm not happy about it",
  "the pun police are on their way",
  "please never stop",
  "that deserves a drum roll",
  "i can't believe i fell for that",
  "incredible, awful, both",
  "full marks, somehow",
  "that one is going in the collection",
  "ugh, that's good",
  "you're lucky that was funny",
  "i'm telling everyone that one",
  "that's a groaner",
  "eye roll, but a fond one",
  "ha, okay, fair",
  "the delivery was perfect",
  "how long were you sitting on that one",
  "i walked right into that",
  "you did not just say that",
  "laughing way too hard at this",
  "an instant classic",
  "unbelievable, and yet i'm smiling",
  "that's getting a slow clap",
  "i felt that one",
  "somebody stop them, i'm crying",
  "okay, respect",
  "that pun had no right to be that good",
  "genuinely wheezing",
  "the audacity of that punchline",
];
