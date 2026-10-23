// LIFE/OS — icons, the pure part (tools/tests/icons.test.js): which icons you can pick for a habit
// or a section, and the icon a name suggests when you haven't picked one ('Drink water' -> a
// drop, 'Gym' -> a dumbbell, 'Recipes' -> a knife and fork). js/icons.js draws them.
//
// A habit or section keeps the icon you picked in its `icon` field. With none, it shows the
// suggested one, so everything has an icon from the start without anyone choosing.

/**
 * The icons you can pick, in the picker's order, each with the words that suggest it (English,
 * plus a few Norwegian and Romanian ones). Words are lower case; a word matches a whole word of
 * the name, or the start of a longer one ('stretching' matches 'stretch').
 */
export const ICON_CHOICES = Object.freeze(
  [
    // Body and health
    { name: 'droplet', label: 'Water', words: ['water', 'hydrate', 'hydration', 'drink', 'vann', 'apa', 'apă'] },
    { name: 'glass', label: 'Drink', words: ['glass', 'juice', 'smoothie', 'wine', 'beer', 'alcohol', 'sober', 'tea'] },
    { name: 'coffee', label: 'Coffee', words: ['coffee', 'caffeine', 'kaffe', 'cafea', 'espresso'] },
    { name: 'utensils', label: 'Meal', words: ['lunch', 'dinner', 'breakfast', 'meal', 'eat', 'food', 'cook', 'cooking', 'recipe', 'recipes', 'mat', 'middag', 'lunsj', 'frokost', 'mancare', 'mâncare', 'pranz', 'cina'] },
    { name: 'apple', label: 'Healthy food', words: ['fruit', 'apple', 'veggies', 'vegetables', 'healthy', 'diet', 'salad', 'nutrition', 'protein'] },
    { name: 'pill', label: 'Medicine', words: ['pill', 'pills', 'vitamin', 'vitamins', 'medicine', 'meds', 'supplement', 'supplements', 'creatine', 'omega'] },
    { name: 'tooth', label: 'Teeth', words: ['teeth', 'tooth', 'floss', 'brush', 'dental', 'tenner', 'dinti', 'dinți'] },
    { name: 'bed', label: 'Sleep', words: ['sleep', 'bed', 'nap', 'rest', 'søvn', 'sove', 'somn', 'dormi'] },
    { name: 'moon', label: 'Night', words: ['night', 'evening', 'bedtime', 'kveld', 'seara', 'seară'] },
    { name: 'sun', label: 'Morning', words: ['morning', 'sunlight', 'sun', 'wake', 'morgen', 'dimineata', 'dimineață'] },
    { name: 'heart', label: 'Health', words: ['health', 'heart', 'love', 'selfcare', 'care', 'helse'] },
    { name: 'scale', label: 'Weight', words: ['weight', 'weigh', 'scale', 'kg', 'vekt'] },
    { name: 'smile', label: 'Mood', words: ['mood', 'happy', 'gratitude', 'grateful', 'smile', 'feel', 'feelings'] },
    { name: 'lotus', label: 'Mindfulness', words: ['meditate', 'meditation', 'mindful', 'mindfulness', 'yoga', 'breathe', 'breathing', 'calm', 'pray', 'prayer', 'meditere'] },
    // Moving
    { name: 'dumbbell', label: 'Gym', words: ['gym', 'workout', 'lift', 'lifting', 'weights', 'strength', 'train', 'training', 'exercise', 'trening', 'sala', 'sală', 'push', 'pull', 'legs', 'pushups', 'situps'] },
    { name: 'run', label: 'Run', words: ['run', 'running', 'jog', 'jogging', 'løpe', 'alergat', 'cardio', 'sprint'] },
    { name: 'walk', label: 'Walk', words: ['walk', 'walking', 'steps', 'hike', 'tur', 'gå', 'plimbare', 'mers'] },
    { name: 'bike', label: 'Bike', words: ['bike', 'cycling', 'cycle', 'bicycle', 'sykkel', 'bicicleta'] },
    { name: 'stretch', label: 'Stretch', words: ['stretch', 'stretching', 'mobility', 'flexibility', 'pilates', 'tøye'] },
    { name: 'mountain', label: 'Outdoors', words: ['outdoors', 'outside', 'mountain', 'nature', 'climb', 'climbing', 'ski', 'skiing', 'fjell'] },
    { name: 'activity', label: 'Sport', words: ['sport', 'sports', 'football', 'soccer', 'tennis', 'polo', 'basketball', 'swim', 'swimming', 'match'] },
    // Mind and learning
    { name: 'book', label: 'Read', words: ['read', 'reading', 'book', 'books', 'lese', 'citit', 'citeste', 'citește', 'novel', 'kindle'] },
    { name: 'pen', label: 'Write', words: ['write', 'writing', 'journal', 'journaling', 'diary', 'dagbok', 'jurnal', 'scrie', 'script', 'scripts', 'blog'] },
    { name: 'graduation', label: 'Study', words: ['study', 'studying', 'school', 'class', 'course', 'exam', 'homework', 'learn', 'learning', 'university', 'uni', 'skole', 'studere', 'facultate'] },
    { name: 'globe', label: 'Language', words: ['language', 'languages', 'spanish', 'french', 'german', 'english', 'norwegian', 'duolingo', 'world'] },
    { name: 'bulb', label: 'Ideas', words: ['idea', 'ideas', 'brainstorm', 'think', 'thoughts', 'ideer', 'idei'] },
    { name: 'music', label: 'Music', words: ['music', 'piano', 'guitar', 'sing', 'song', 'songs', 'practice', 'instrument', 'musikk', 'muzica', 'muzică'] },
    { name: 'palette', label: 'Art', words: ['art', 'draw', 'drawing', 'paint', 'painting', 'design', 'sketch', 'creative'] },
    { name: 'camera', label: 'Photo', words: ['photo', 'photos', 'pictures', 'camera', 'photography', 'bilder'] },
    { name: 'video', label: 'Video', words: ['video', 'videos', 'tiktok', 'youtube', 'reels', 'film', 'content', 'vlog', 'shorts'] },
    { name: 'code', label: 'Code', words: ['code', 'coding', 'programming', 'dev', 'develop', 'app', 'github'] },
    // Life and home
    { name: 'home', label: 'Home', words: ['home', 'house', 'life', 'personal', 'family', 'hjem', 'acasa', 'acasă', 'casa'] },
    { name: 'sparkles', label: 'Clean', words: ['clean', 'cleaning', 'tidy', 'declutter', 'vacuum', 'dishes', 'rydde', 'curat', 'curatenie'] },
    { name: 'shirt', label: 'Clothes', words: ['laundry', 'clothes', 'wash', 'outfit', 'wardrobe', 'klær', 'haine'] },
    { name: 'sprout', label: 'Plants', words: ['plant', 'plants', 'garden', 'gardening', 'grow', 'flowers'] },
    { name: 'paw', label: 'Pet', words: ['dog', 'cat', 'pet', 'pets', 'hund', 'katt', 'caine', 'câine', 'pisica'] },
    { name: 'users', label: 'People', words: ['friends', 'family', 'social', 'people', 'meet', 'date', 'venner', 'prieteni', 'mum', 'mom', 'dad', 'parents'] },
    { name: 'phone', label: 'Call', words: ['call', 'phone', 'ring', 'calls', 'suna', 'sună'] },
    { name: 'phone-off', label: 'No phone', words: ['nophone', 'no phone', 'screen', 'screentime', 'detox', 'offline', 'scrolling', 'social media'] },
    { name: 'mail', label: 'Mail', words: ['mail', 'email', 'emails', 'inbox', 'letters'] },
    // Work and money
    { name: 'briefcase', label: 'Work', words: ['work', 'job', 'office', 'business', 'client', 'clients', 'meeting', 'jobb', 'arbeid', 'munca', 'muncă', 'career'] },
    { name: 'target', label: 'Goal', words: ['goal', 'goals', 'focus', 'plan', 'planning', 'mål', 'obiectiv'] },
    { name: 'wallet', label: 'Money', words: ['money', 'budget', 'finance', 'finances', 'bills', 'pay', 'payment', 'bank', 'penger', 'bani'] },
    { name: 'coins', label: 'Save', words: ['save', 'saving', 'savings', 'invest', 'investing', 'stocks', 'crypto', 'spare', 'economii'] },
    { name: 'cart', label: 'Shopping', words: ['shopping', 'shop', 'groceries', 'grocery', 'buy', 'store', 'handle', 'handleliste', 'cumparaturi', 'cumpărături'] },
    { name: 'gift', label: 'Gift', words: ['gift', 'gifts', 'present', 'presents', 'christmas', 'gave', 'cadou', 'cadouri'] },
    { name: 'cake', label: 'Birthday', words: ['birthday', 'birthdays', 'party', 'celebrate', 'cake', 'bursdag', 'aniversare'] },
    { name: 'plane', label: 'Travel', words: ['travel', 'trip', 'trips', 'flight', 'flights', 'vacation', 'holiday', 'reise', 'ferie', 'calatorie', 'călătorie', 'vacanta', 'vacanță'] },
    { name: 'car', label: 'Car', words: ['car', 'drive', 'driving', 'bil', 'masina', 'mașină', 'fuel'] },
    { name: 'gamepad', label: 'Games', words: ['game', 'games', 'gaming', 'play', 'playstation', 'xbox', 'nintendo', 'switch'] },
    { name: 'tv', label: 'Watch', words: ['tv', 'watch', 'movie', 'movies', 'series', 'netflix', 'show', 'shows'] },
    // General
    { name: 'note', label: 'Note', words: ['note', 'notes', 'notater'] },
    { name: 'folder', label: 'Folder', words: ['folder', 'files', 'archive', 'misc', 'other', 'stuff', 'unsorted'] },
    { name: 'star', label: 'Favourite', words: ['favourite', 'favorite', 'favorites', 'best', 'important', 'starred', 'top'] },
    { name: 'flag', label: 'Flag', words: ['flag', 'urgent', 'priority', 'deadline'] },
    { name: 'zap', label: 'Energy', words: ['energy', 'quick', 'power', 'boost', 'zap'] },
    { name: 'flame', label: 'Streak', words: ['streak', 'fire', 'hot', 'challenge'] },
    { name: 'hash', label: 'Tag', words: ['tag', 'tags', 'topic', 'topics', 'hashtag'] },
    { name: 'play', label: 'Play', words: ['podcast', 'podcasts', 'listen', 'audio', 'audiobook'] },
    { name: 'clock', label: 'Time', words: ['time', 'routine', 'schedule', 'early', 'late', 'timer'] },
  ].map((c) => Object.freeze({ ...c, words: Object.freeze(c.words) })),
);

export const ICON_NAMES = Object.freeze(ICON_CHOICES.map((c) => c.name));

/** A stored icon, if it is one of the choices (anything else -> null). */
export function cleanIcon(name) {
  return typeof name === 'string' && ICON_NAMES.includes(name) ? name : null;
}

/** The words of a name: lower case, accents kept, split on anything that isn't a letter or digit. */
function wordsOf(text) {
  return String(text ?? '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** One letter added, removed or changed (a typo like 'lumch' or 'readd'). */
function oneEditApart(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/**
 * The icon a name suggests, or `fallback`. A phrase ('no phone') wins over a whole-word match,
 * which wins over the start of a longer word ('stretching'; keys of 4 letters or more, so 'mat'
 * doesn't catch 'math'), which wins over a one-letter typo ('lumch'; words of 5 letters or more, so
 * 'long' doesn't pass for 'song').
 * An earlier word of the name wins a tie ('Gym shoes' -> the dumbbell).
 */
export function suggestIcon(text, fallback = null) {
  const words = wordsOf(text);
  if (!words.length) return fallback;
  const joined = words.join(' ');
  let best = null;
  const consider = (name, score, at) => {
    if (!best || score > best.score || (score === best.score && at < best.at)) best = { name, score, at };
  };
  for (const choice of ICON_CHOICES) {
    for (const key of choice.words) {
      // Phrases ('social media') match the name's words in a row
      if (key.includes(' ')) {
        const at = joined.indexOf(key);
        if (at !== -1 && (at === 0 || joined[at - 1] === ' ')) consider(choice.name, 4, 0);
        continue;
      }
      words.forEach((w, at) => {
        if (w === key) consider(choice.name, 3, at);
        else if (key.length >= 4 && w.length > key.length && w.startsWith(key)) consider(choice.name, 2, at);
        else if (key.length >= 5 && w.length >= 5 && oneEditApart(w, key)) consider(choice.name, 1, at);
      });
    }
  }
  return best ? best.name : fallback;
}

/** The icon to draw for something with a name and maybe a picked icon (habit, section). */
export function iconOf(item, fallback) {
  return cleanIcon(item?.icon) ?? suggestIcon(item?.name, fallback);
}

/**
 * Each page's own icon and color tone, used in the menu, page tops and Home's widgets:
 * the color comes from css/icons.css (--mod-<tone>), the icon from the app's page list.
 */
export const PAGE_TONES = Object.freeze(['home', 'tasks', 'notes', 'habits', 'calendar', 'pomodoro', 'training', 'finance', 'recovery', 'health', 'settings']);
