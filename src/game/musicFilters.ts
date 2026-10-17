import { PartyMember } from '../party/partyEngine';
import { Track } from '../providers/types';

export type PoolMatchMode = 'all' | 'shared' | 'similar';

export type MusicGenreId =
  | 'pop'
  | 'rock'
  | 'hiphop'
  | 'rnb'
  | 'electronic'
  | 'metal'
  | 'latin'
  | 'country'
  | 'soundtrack';

export type MusicEraId = 'pre-80s' | '1980s' | '1990s' | '2000s' | '2010s' | '2020s';

export interface PreGameFilterConfig {
  matchMode: PoolMatchMode;
  genres: MusicGenreId[];
  eras: MusicEraId[];
}

export const DEFAULT_FILTER_CONFIG: PreGameFilterConfig = {
  matchMode: 'all',
  genres: [],
  eras: [],
};

export interface GenreOption {
  id: MusicGenreId;
  label: string;
  shortLabel: string;
}

export interface EraOption {
  id: MusicEraId;
  label: string;
  shortLabel: string;
}

export const MUSIC_GENRE_OPTIONS: GenreOption[] = [
  { id: 'pop', label: 'Pop & Synth', shortLabel: 'Pop' },
  { id: 'rock', label: 'Rock, Indie & Alt', shortLabel: 'Rock / Indie' },
  { id: 'hiphop', label: 'Hip-Hop & Rap', shortLabel: 'Hip-Hop' },
  { id: 'electronic', label: 'Electronic & Dance', shortLabel: 'Electronic' },
  { id: 'rnb', label: 'R&B, Soul & Funk', shortLabel: 'R&B / Soul' },
  { id: 'metal', label: 'Metal, Punk & Hard Rock', shortLabel: 'Metal / Punk' },
  { id: 'latin', label: 'Latin, Reggaeton & Afro', shortLabel: 'Latin / Afro' },
  { id: 'country', label: 'Country, Folk & Acoustic', shortLabel: 'Country / Folk' },
  { id: 'soundtrack', label: 'Jazz, Classical & OST', shortLabel: 'Jazz / OST' },
];

export const MUSIC_ERA_OPTIONS: EraOption[] = [
  { id: 'pre-80s', label: 'Pre-80s (60s & 70s)', shortLabel: 'Pre-80s' },
  { id: '1980s', label: '1980s', shortLabel: '80s' },
  { id: '1990s', label: '1990s', shortLabel: '90s' },
  { id: '2000s', label: '2000s', shortLabel: '2000s' },
  { id: '2010s', label: '2010s', shortLabel: '2010s' },
  { id: '2020s', label: '2020s', shortLabel: '2020s' },
];

const GENRE_KEYWORDS: Record<MusicGenreId, string[]> = {
  pop: [
    'taylor swift',
    'ed sheeran',
    'dua lipa',
    'ariana grande',
    'billie eilish',
    'olivia rodrigo',
    'sabrina carpenter',
    'chappell roan',
    'lady gaga',
    'katy perry',
    'rihanna',
    'justin bieber',
    'justin timberlake',
    'bruno mars',
    'adele',
    'harry styles',
    'one direction',
    'shawn mendes',
    'camila cabello',
    'selena gomez',
    'miley cyrus',
    'demi lovato',
    'britney spears',
    'christina aguilera',
    'madonna',
    'michael jackson',
    'george michael',
    'wham',
    'abba',
    'bee gees',
    'elton john',
    'billy joel',
    'phil collins',
    'whitney houston',
    'celine dion',
    'mariah carey',
    'backstreet boys',
    'nsync',
    'spice girls',
    'robbie williams',
    'kylieminogue',
    'kylie minogue',
    'sia',
    'lorde',
    'lana del rey',
    'charli xcx',
    'troye sivan',
    'carly rae jepsen',
    'halsey',
    'lauv',
    'conan gray',
    'benson boone',
    'tate mcrae',
    'zara larsson',
    'ava max',
    'anne-marie',
    'lewis capaldi',
    'sam smith',
    'meghan trainor',
    'maroon 5',
    'onerepublic',
    'the script',
    'coldplay',
    'a-ha',
    'tears for fears',
    'duran duran',
    'depeche mode',
    'eurythmics',
    'cyndi lauper',
    'rick astley',
    'modern talking',
    'nena',
    'falco',
    'herbert grönemeyer',
    'mark forster',
    'lea',
    'nina chuba',
    'bts',
    'blackpink',
    'newjeans',
    'twice',
    'stray kids',
    'jung kook',
    'rosé',
    'lisa',
    'pop',
    'synthpop',
    'electropop',
  ],
  rock: [
    'queen',
    'the beatles',
    'beatles',
    'rolling stones',
    'led zeppelin',
    'pink floyd',
    'fleetwood mac',
    'david bowie',
    'eagles',
    'creedence clearwater',
    'dire straits',
    'the police',
    'u2',
    'bruce springsteen',
    'tom petty',
    'journey',
    'toto',
    'foreigner',
    'boston',
    'survivor',
    'bon jovi',
    'bryan adams',
    'oasis',
    'blur',
    'pulp',
    'the verve',
    'radiohead',
    'nirvana',
    'pearl jam',
    'foo fighters',
    'red hot chili peppers',
    'weezer',
    'smashing pumpkins',
    'rem',
    'r.e.m.',
    'the cure',
    'the smiths',
    'joy division',
    'new order',
    'the cranberr',
    'no doubt',
    'alanis morissette',
    'goo goo dolls',
    'matchbox twenty',
    'third eye blind',
    'nickelback',
    'creed',
    '3 doors down',
    'the killers',
    'the strokes',
    'arctic monkeys',
    'muse',
    'kasabian',
    'franz ferdinand',
    'interpol',
    'the white stripes',
    'the black keys',
    'kings of leon',
    'queens of the stone age',
    'gorillaz',
    'tame impala',
    'glass animals',
    'foster the people',
    'mgmt',
    'vampire weekend',
    'phoenix',
    'two door cinema club',
    'the 1975',
    'bastille',
    'imagine dragons',
    'twenty one pilots',
    'fall out boy',
    'panic! at the disco',
    'paramore',
    'my chemical romance',
    'all time low',
    'the neighbourhood',
    'cage the elephant',
    'portugal. the man',
    'alt-j',
    'florence + the machine',
    'florence and the machine',
    'hozier',
    'mac demarco',
    'mitski',
    'phoebe bridgers',
    'boygenius',
    'clairo',
    'beabadoobee',
    'fontaines d.c.',
    'idles',
    'måneskin',
    'maneskin',
    'annenmaykantereit',
    'kraftklub',
    'sportfreunde stiller',
    'wir sind helden',
    'juli',
    'silbermond',
    'wanda',
    'bilderbuch',
    'giant rooks',
    'milky chance',
    'indie',
    'alternative',
    'rock',
    'grunge',
    'post-punk',
    'britpop',
  ],
  hiphop: [
    'eminem',
    'drake',
    'kendrick lamar',
    'kanye west',
    'ye',
    'jay-z',
    'j. cole',
    'travis scott',
    'post malone',
    '50 cent',
    'snoop dogg',
    'dr. dre',
    '2pac',
    'tupac',
    'notorious b.i.g.',
    'biggie',
    'nas',
    'wu-tang',
    'outkast',
    'lil wayne',
    'nicki minaj',
    'cardi b',
    'megan thee stallion',
    'doja cat',
    'ice spice',
    'future',
    'metro boomin',
    '21 savage',
    'lil uzi vert',
    'playboi carti',
    'juice wrld',
    'xxxtentacion',
    'pop smoke',
    'lil baby',
    'gunna',
    'young thug',
    'migos',
    'quavo',
    'offset',
    'takeoff',
    'a$ap rocky',
    'asap rocky',
    'tyler, the creator',
    'mac miller',
    'childish gambino',
    'chance the rapper',
    'logic',
    'nf',
    'macklemore',
    'wiz khalifa',
    'kid cudi',
    'denzel curry',
    'jid',
    'jack harlow',
    'central cee',
    'dave',
    'stormzy',
    'skepta',
    'bbno$',
    'yeat',
    'don toliver',
    'baby keem',
    'nelly',
    'ludacris',
    't.i.',
    'flo rida',
    'pitbull',
    'sean paul',
    'black eyed peas',
    'cypress hill',
    'beastie boys',
    'run-d.m.c.',
    'public enemy',
    'a tribe called quest',
    'fugees',
    'lauryn hill',
    'missy elliott',
    'busta rhymes',
    'dmx',
    'raf camora',
    'bonez mc',
    'gzuz',
    'apache 207',
    'shirindavid',
    'shirin david',
    'capital bra',
    'luciano',
    'pashanim',
    'ski aggu',
    '01099',
    'cro',
    'marteria',
    'casper',
    'peter fox',
    'seeed',
    'sido',
    'bushido',
    'kollegah',
    'alligatoah',
    'k.i.z',
    'trailerpark',
    'ssio',
    'haftbefehl',
    'rin',
    'bausa',
    'reezy',
    't-low',
    'makko',
    'hip hop',
    'hip-hop',
    'rap',
    'drill',
    'trap',
    'freestyle',
    'cypher',
  ],
  electronic: [
    'daft punk',
    'avicii',
    'calvin harris',
    'david guetta',
    'tiësto',
    'tiesto',
    'swedish house mafia',
    'axwell',
    'ingrosso',
    'alesso',
    'martin garrix',
    'zedd',
    'kygo',
    'alan walker',
    'marshmello',
    'the chainsmokers',
    'chainsmokers',
    'skrillex',
    'diplo',
    'major lazer',
    'jack ü',
    'deadmau5',
    'eric prydz',
    'armin van buuren',
    'above & beyond',
    'paul van dyk',
    'atb',
    'scooter',
    'cascada',
    'basshunter',
    'darude',
    'gigi d’agostino',
    'gigi d agostino',
    'robert miles',
    'faithless',
    'the prodigy',
    'chemical brothers',
    'fatboy slim',
    'basement jaxx',
    'underworld',
    'massive attack',
    'portishead',
    'moby',
    'aphex twin',
    'boards of canada',
    'justice',
    'gesaffelstein',
    'kavinsky',
    'disclosure',
    'flume',
    'odesza',
    'porter robinson',
    'madeon',
    'illenium',
    'rufus du sol',
    'rüfüs du sol',
    'fred again',
    'peggy gou',
    'fisher',
    'chris lake',
    'john summit',
    'dom dolla',
    'bicep',
    'kaytranada',
    'four tet',
    'jamie xx',
    'bonobo',
    'caribou',
    'purple disco machine',
    'robin schulz',
    'felix jaehn',
    'alle farben',
    'lost frequencies',
    'of monsters',
    'kungs',
    'meduza',
    'topic',
    'acraze',
    'sub focus',
    'wilkinson',
    'dimension',
    'netsky',
    'pendulum',
    'chase & status',
    'rudimental',
    'sigma',
    'galantis',
    'clean bandit',
    'paul kalkbrenner',
    'boris brejcha',
    'charlotte de witte',
    'amelie lens',
    'solomun',
    'camelphat',
    'artbat',
    'anyma',
    'stromae',
    'remix',
    'club mix',
    'extended mix',
    'vip mix',
    'radio edit',
    'bootleg',
    'mashup',
    'techno',
    'house',
    'trance',
    'dubstep',
    'drum & bass',
    'drum and bass',
    'dnb',
    'edm',
    'hardstyle',
    'hardtekk',
    'rave',
  ],
  rnb: [
    'the weeknd',
    'sza',
    'frank ocean',
    'beyoncé',
    'beyonce',
    'usher',
    'chris brown',
    'ne-yo',
    'alicia keys',
    'john legend',
    'amy winehouse',
    'stevie wonder',
    'marvin gaye',
    'aretha franklin',
    'ray charles',
    'james brown',
    'earth, wind & fire',
    'kool & the gang',
    'chic',
    'diana ross',
    'the supremes',
    'the temptations',
    'bill withers',
    'al green',
    'otis redding',
    'curtis mayfield',
    'prince',
    'lionel richie',
    'luther vandross',
    'sade',
    'jamiroquai',
    'tlc',
    'destiny’s child',
    'destinys child',
    'boyz ii men',
    'r. kelly',
    'aaliyah',
    'mary j. blige',
    'erykah badu',
    'd’angelo',
    'anderson .paak',
    'silk sonic',
    'miguel',
    'brent faiyaz',
    'bryson tiller',
    'partynextdoor',
    '6lack',
    'daniel caesar',
    'giveon',
    'h.e.r.',
    'summer walker',
    'jhené aiko',
    'kehlani',
    'kali uchis',
    'steve lacy',
    'thundercat',
    'leon bridges',
    'michael kiwanuka',
    'r&b',
    'soul',
    'funk',
    'motown',
    'disco',
  ],
  metal: [
    'metallica',
    'iron maiden',
    'black sabbath',
    'ozzy osbourne',
    'judas priest',
    'motörhead',
    'motorhead',
    'slayer',
    'megadeth',
    'anthrax',
    'pantera',
    'sepultura',
    'ac/dc',
    'guns n’ roses',
    'guns n roses',
    'aerosmith',
    'van halen',
    'def leppard',
    'mötley crüe',
    'motley crue',
    'kiss',
    'scorpions',
    'deep purple',
    'rainbow',
    'dio',
    'linkin park',
    'system of a down',
    'slipknot',
    'korn',
    'limp bizkit',
    'deftones',
    'rage against the machine',
    'tool',
    'disturbed',
    'avenged sevenfold',
    'bullet for my valentine',
    'trivium',
    'killswitch engage',
    'parkway drive',
    'architects',
    'bring me the horizon',
    'bad omens',
    'sleep token',
    'spiritbox',
    'lorna shore',
    'knocked loose',
    'ghost',
    'gojira',
    'mastodon',
    'lamb of god',
    'in flames',
    'arch enemy',
    'amuon amarth',
    'amon amarth',
    'sabaton',
    'powerwolf',
    'nightwish',
    'within temptation',
    'evanescence',
    'rammstein',
    'electric callboy',
    'eskimo callboy',
    'die ärzte',
    'die toten hosen',
    'beatsteaks',
    'broilers',
    'billy talent',
    'rise against',
    'green day',
    'blink-182',
    'sum 41',
    'the offspring',
    'bad religion',
    'nofx',
    'ramones',
    'sex pistols',
    'the clash',
    'misfits',
    'volbeat',
    'five finger death punch',
    'papa roach',
    'three days grace',
    'breaking benjamin',
    'skillet',
    'shinedown',
    'halestorm',
    'metal',
    'metalcore',
    'deathcore',
    'hardcore',
    'punk',
    'nu metal',
  ],
  latin: [
    'bad bunny',
    'j balvin',
    'daddy yankee',
    'ozuna',
    'maluma',
    'karol g',
    'feid',
    'rauw alejandro',
    'anuel aa',
    'nicky jam',
    'farruko',
    'myke towers',
    'jhayco',
    'peso pluma',
    'fuerza regida',
    'grupo frontera',
    'junior h',
    'natanael cano',
    'shakira',
    'rosalía',
    'rosalia',
    'enrique iglesias',
    'ricky martin',
    'marc anthony',
    'romeo santos',
    'aventura',
    'juanes',
    'carlos vives',
    'luis fonsi',
    'camila',
    'manu chao',
    'gipsy kings',
    'santana',
    'gloria estefan',
    'celia cruz',
    'selena',
    'burna boy',
    'wizkid',
    'davido',
    'rema',
    'tyla',
    'ayra starr',
    'ckay',
    'omah lay',
    'asake',
    'fireboy dml',
    'bob marley',
    'shaggy',
    'damian marley',
    'ub40',
    'reggaeton',
    'latin',
    'bachata',
    'salsa',
    'merengue',
    'cumbia',
    'afrobeats',
    'dembow',
  ],
  country: [
    'johnny cash',
    'dolly parton',
    'john denver',
    'willie nelson',
    'kenny rogers',
    'garth brooks',
    'shania twain',
    'faith hill',
    'tim mcgraw',
    'keith urban',
    'CARRIE UNDERWOOD',
    'carrie underwood',
    'miranda lambert',
    'blake shelton',
    'luke bryan',
    'jason aldean',
    'zac brown band',
    'florida georgia line',
    'morgan wallen',
    'luke combs',
    'zach bryan',
    'chris stapleton',
    'tyler childers',
    'kacey musgraves',
    'noah kahan',
    'mumford & sons',
    'mumford and sons',
    'the lumineers',
    'of monsters and men',
    'vance joy',
    'passenger',
    'george ezra',
    'james bay',
    'ben howard',
    'bon iver',
    'iron & wine',
    'sufjan stevens',
    'fleet foxes',
    'simon & garfunkel',
    'bob dylan',
    'neil young',
    'joni mitchell',
    'cat stevens',
    'jim croce',
    'america',
    'jack johnson',
    'jason mraz',
    'tracy chapman',
    'country',
    'folk',
    'bluegrass',
    'americana',
    'acoustic',
    'unplugged',
  ],
  soundtrack: [
    'hans zimmer',
    'john williams',
    'ennio morricone',
    'howard shore',
    'james horner',
    'danny elfman',
    'ramin djawadi',
    'ludwig göransson',
    'ludwig goransson',
    'alexandre desplat',
    'thomas newman',
    'michael giacchino',
    'clint mansell',
    'max richter',
    'ludovico einaudi',
    'yann tiersen',
    'joe hisaishi',
    'nobuo uematsu',
    'koji kondo',
    'toby fox',
    'c418',
    'lena raine',
    'lorne balfe',
    'two steps from hell',
    'audiomachine',
    'mozart',
    'beethoven',
    'bach',
    'chopin',
    'tchaikovsky',
    'vivaldi',
    'debussy',
    'rachmaninoff',
    'frank sinatra',
    'louis armstrong',
    'miles davis',
    'john coltrane',
    'ella fitzgerald',
    'nina simone',
    'billie holiday',
    'chet baker',
    'dave brubeck',
    'nat king cole',
    'dean martin',
    'bobby darin',
    'michael bublé',
    'michael buble',
    'norah jones',
    'laufey',
    'kamasi washington',
    'snarky puppy',
    'soundtrack',
    'original score',
    'main theme',
    'ost',
    'symphony',
    'orchestra',
    'philharmonic',
    'concerto',
    'sonata',
    'nocturne',
  ],
};

const ARTIST_ERA_LOOKUP: Record<MusicEraId, string[]> = {
  'pre-80s': [
    'the beatles',
    'beatles',
    'rolling stones',
    'led zeppelin',
    'pink floyd',
    'queen',
    'fleetwood mac',
    'abba',
    'bee gees',
    'elton john',
    'david bowie',
    'stevie wonder',
    'marvin gaye',
    'aretha franklin',
    'ray charles',
    'james brown',
    'otis redding',
    'bill withers',
    'al green',
    'eagles',
    'creedence clearwater',
    'black sabbath',
    'deep purple',
    'jimi hendrix',
    'the doors',
    'the who',
    'lynyrd skynyrd',
    'boston',
    'electric light orchestra',
    'elo',
    'supertramp',
    'dire straits',
    'simon & garfunkel',
    'bob dylan',
    'neil young',
    'john denver',
    'johnny cash',
    'dolly parton',
    'frank sinatra',
    'elvis presley',
    'chuck berry',
    'beach boys',
    'bob marley',
    'earth, wind & fire',
    'kool & the gang',
    'boney m',
    'donna summer',
    'gloria gaynor',
    'chic',
    'jackson 5',
    'the temptations',
    'the supremes',
  ],
  '1980s': [
    'michael jackson',
    'prince',
    'madonna',
    'whitney houston',
    'george michael',
    'wham',
    'phil collins',
    'genesis',
    'toto',
    'journey',
    'foreigner',
    'survivor',
    'reospeedwagon',
    'bon jovi',
    'guns n’ roses',
    'guns n roses',
    'def leppard',
    'van halen',
    'mötley crüe',
    'motley crue',
    'ac/dc',
    'metallica',
    'iron maiden',
    'judas priest',
    'ozzy osbourne',
    'scorpions',
    'a-ha',
    'tears for fears',
    'depeche mode',
    'new order',
    'the cure',
    'the smiths',
    'the police',
    'u2',
    'duran duran',
    'eurythmics',
    'cyndi lauper',
    'rick astley',
    'bryan adams',
    'bruce springsteen',
    'billy idol',
    'billy joel',
    'hall & oates',
    'lionel richie',
    'sade',
    'pet shop boys',
    'erasures',
    'soft cell',
    'human league',
    'flock of seagulls',
    'simple minds',
    'inxs',
    'men at work',
    'midnight oil',
    'talking heads',
    'blondie',
    'the clash',
    'ramones',
    'modern talking',
    'nena',
    'falco',
    'alphaville',
    'sandra',
  ],
  '1990s': [
    'nirvana',
    'pearl jam',
    'soundgarden',
    'alice in chains',
    'stone temple pilots',
    'smashing pumpkins',
    'oasis',
    'blur',
    'pulp',
    'the verve',
    'radiohead',
    'red hot chili peppers',
    'green day',
    'the offspring',
    'blink-182',
    'weezer',
    'no doubt',
    'the cranberries',
    'alanis morissette',
    'goo goo dolls',
    'third eye blind',
    'rem',
    'r.e.m.',
    'rage against the machine',
    'korn',
    'limp bizkit',
    'deftones',
    'tool',
    'pantera',
    '2pac',
    'tupac',
    'notorious b.i.g.',
    'biggie',
    'nas',
    'wu-tang',
    'dr. dre',
    'snoop dogg',
    'cypress hill',
    'beastie boys',
    'fugees',
    'lauryn hill',
    'tlc',
    'boyz ii men',
    'aaliyah',
    'mary j. blige',
    'jamiroquai',
    'spice girls',
    'backstreet boys',
    'nsync',
    'britney spears',
    'christina aguilera',
    'celine dion',
    'mariah carey',
    'shania twain',
    'garth brooks',
    'the prodigy',
    'chemical brothers',
    'fatboy slim',
    'faithless',
    'underworld',
    'massive attack',
    'portishead',
    'moby',
    'daft punk',
    'scooter',
    'atb',
    'darude',
    'gigi d’agostino',
    'robert miles',
  ],
  '2000s': [
    'linkin park',
    'eminem',
    '50 cent',
    'jay-z',
    'kanye west',
    'outkast',
    'nelly',
    'ludacris',
    't.i.',
    'lil wayne',
    'usher',
    'alicia keys',
    'beyoncé',
    'beyonce',
    'destiny’s child',
    'rihanna',
    'justin timberlake',
    'nelly furtado',
    'shakira',
    'black eyed peas',
    'lady gaga',
    'amy winehouse',
    'coldplay',
    'gorillaz',
    'the strokes',
    'the white stripes',
    'the killers',
    'arctic monkeys',
    'muse',
    'franz ferdinand',
    'kasabian',
    'interpol',
    'kings of leon',
    'queens of the stone age',
    'foo fighters',
    'system of a down',
    'slipknot',
    'disturbed',
    'evanescence',
    'my chemical romance',
    'fall out boy',
    'paramore',
    'panic! at the disco',
    'sum 41',
    'billy talent',
    'rise against',
    'three days grace',
    'breaking benjamin',
    'papa roach',
    'nickelback',
    '3 doors down',
    'avril lavigne',
    'kelly clarkson',
    'pink',
    'p!nk',
    'robbie williams',
    'james blunt',
    'keane',
    'snow patrol',
    'tiësto',
    'tiesto',
    'david guetta',
    'cascada',
    'basshunter',
    'bob sinclar',
    'eric prydz',
    'benny benassi',
    'justice',
    'peter fox',
    'seeed',
    'wir sind helden',
    'juli',
    'silbermond',
    'sido',
  ],
  '2010s': [
    'avicii',
    'calvin harris',
    'swedish house mafia',
    'skrillex',
    'deadmau5',
    'zedd',
    'martin garrix',
    'kygo',
    'alan walker',
    'marshmello',
    'the chainsmokers',
    'chainsmokers',
    'major lazer',
    'diplo',
    'disclosure',
    'flume',
    'odesza',
    'porter robinson',
    'galantis',
    'clean bandit',
    'robin schulz',
    'felix jaehn',
    'alle farben',
    'lost frequencies',
    'drake',
    'kendrick lamar',
    'j. cole',
    'travis scott',
    'post malone',
    'future',
    'migos',
    'young thug',
    'a$ap rocky',
    'asap rocky',
    'tyler, the creator',
    'frank ocean',
    'childish gambino',
    'mac miller',
    'wiz khalifa',
    'kid cudi',
    'macklemore',
    'juice wrld',
    'xxxtentacion',
    'lil uzi vert',
    '21 savage',
    'cardi b',
    'nicki minaj',
    'the weeknd',
    'bruno mars',
    'ed sheeran',
    'adele',
    'taylor swift',
    'ariana grande',
    'katy perry',
    'sia',
    'lorde',
    'lana del rey',
    'halsey',
    'shawn mendes',
    'camila cabello',
    'one direction',
    'justin bieber',
    'sam smith',
    'lewis capaldi',
    'maroon 5',
    'onerepublic',
    'imagine dragons',
    'twenty one pilots',
    'bastille',
    'hozier',
    'florence + the machine',
    'tame impala',
    'mgmt',
    'foster the people',
    'two door cinema club',
    'the 1975',
    'the neighbourhood',
    'arctic monkeys',
    'the black keys',
    'mumford & sons',
    'the lumineers',
    'vance joy',
    'passenger',
    'george ezra',
    'stromae',
    'milky chance',
    'annenmaykantereit',
    'kraftklub',
    'cro',
    'marteria',
    'casper',
    'alligatoah',
    'raf camora',
    'bonez mc',
    'bausa',
  ],
  '2020s': [
    'olivia rodrigo',
    'dua lipa',
    'billie eilish',
    'sabrina carpenter',
    'chappell roan',
    'doja cat',
    'sza',
    'ice spice',
    'central cee',
    'jack harlow',
    'yeat',
    'playboi carti',
    'don toliver',
    'metro boomin',
    'pop smoke',
    'lil baby',
    'gunna',
    'bad bunny',
    'karol g',
    'feid',
    'peso pluma',
    'rauw alejandro',
    'rosalía',
    'rosalia',
    'burna boy',
    'rema',
    'tyla',
    'ayra starr',
    'fred again',
    'peggy gou',
    'john summit',
    'dom dolla',
    'fisher',
    'purple disco machine',
    'meduza',
    'benson boone',
    'tate mcrae',
    'noah kahan',
    'zach bryan',
    'morgan wallen',
    'luke combs',
    'harry styles',
    'måneskin',
    'maneskin',
    'sleep token',
    'bad omens',
    'spiritbox',
    'electric callboy',
    'fontaines d.c.',
    'glass animals',
    'steve lacy',
    'kali uchis',
    'brent faiyaz',
    'newjeans',
    'blackpink',
    'bts',
    'stray kids',
    'jung kook',
    'ski aggu',
    'nina chuba',
    'pashanim',
    'apache 207',
    '01099',
    'makko',
    't-low',
    'shirin david',
    'laufey',
  ],
};

export function normalizeArtistTokens(track: Track): string[] {
  const rawSources = [track.artist];
  if (track.title.includes(' - ')) {
    rawSources.push(track.title.split(' - ')[0]);
  }
  const tokens = new Set<string>();
  for (const src of rawSources) {
    const parts = src
      .toLowerCase()
      .replace(/\s*-\s*topic$/i, '')
      .split(/,|&|\bfeat\.?\b|\bft\.?\b|\bx\b|\band\b|;/i);
    for (const part of parts) {
      const cleaned = part.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
      if (cleaned && cleaned.length >= 2 && cleaned !== 'unknown artist') {
        tokens.add(cleaned);
      }
    }
  }
  return Array.from(tokens);
}

/**
 * Infers one or more genres (`MusicGenreId[]`) for a track using artist + title + metadata.
 */
export function inferTrackGenres(track: Track): MusicGenreId[] {
  const matched = new Set<MusicGenreId>();
  const haystack = `${track.artist} ${track.title} ${track.channelTitle ?? ''}`.toLowerCase();

  for (const genreOption of MUSIC_GENRE_OPTIONS) {
    const keywords = GENRE_KEYWORDS[genreOption.id];
    for (const kw of keywords) {
      if (kw.length <= 4) {
        const regex = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        if (regex.test(haystack)) {
          matched.add(genreOption.id);
          break;
        }
      } else if (haystack.includes(kw)) {
        matched.add(genreOption.id);
        break;
      }
    }
  }

  // Fallback structural cues if no explicit keyword/artist matched
  if (matched.size === 0) {
    if (/\b(dj|club|mix|edit|vip|bass|synth|electro|dance|beat)\b/i.test(haystack)) {
      matched.add('electronic');
    } else if (/\b(lil|young|big|da|mc|prod\.|feat\.|ft\.)\b/i.test(haystack)) {
      matched.add('hiphop');
    } else if (/\b(the\s+\w+|band|boys|brothers|sisters)\b/i.test(haystack)) {
      matched.add('rock');
    } else {
      matched.add('pop');
    }
  }

  return Array.from(matched);
}

function yearToEra(year: number): MusicEraId {
  if (year < 1980) return 'pre-80s';
  if (year < 1990) return '1980s';
  if (year < 2000) return '1990s';
  if (year < 2010) return '2000s';
  if (year < 2020) return '2010s';
  return '2020s';
}

/**
 * Infers the decade/era (`MusicEraId`) for a track using releaseYear, title cues, and artist era lookup.
 */
export function inferTrackEra(track: Track): MusicEraId {
  const haystack = `${track.artist} ${track.title}`.toLowerCase();

  // 1. Check for explicit decade mentions in title (e.g., "80s", "90s")
  if (/\b(60s|70s|196\d|197\d)\b/.test(haystack) && !/remaster/i.test(haystack)) {
    return 'pre-80s';
  }
  if (/\b(80s|198\d)\b/.test(haystack) && !/remaster/i.test(haystack)) {
    return '1980s';
  }
  if (/\b(90s|199\d)\b/.test(haystack) && !/remaster/i.test(haystack)) {
    return '1990s';
  }

  // 2. Check Artist Era Lookup first for classic artists or YouTube tracks (where upload date != release year)
  for (const eraOption of MUSIC_ERA_OPTIONS) {
    const artists = ARTIST_ERA_LOOKUP[eraOption.id];
    for (const artistKw of artists) {
      if (haystack.includes(artistKw)) {
        // If Spotify has an explicit releaseYear that isn't a modern remaster of a pre-2000 band, respect Spotify
        if (
          track.provider === 'spotify' &&
          track.releaseYear &&
          !(eraOption.id === 'pre-80s' && track.releaseYear >= 2000) &&
          !(eraOption.id === '1980s' && track.releaseYear >= 2000) &&
          !(eraOption.id === '1990s' && track.releaseYear >= 2005)
        ) {
          return yearToEra(track.releaseYear);
        }
        return eraOption.id;
      }
    }
  }

  // 3. Use releaseYear if available
  if (track.releaseYear && track.releaseYear >= 1900 && track.releaseYear <= 2035) {
    // If title says "Remaster", it's typically a classic track from pre-2000 even if album re-released later
    if (/remaster/i.test(track.title) && track.releaseYear >= 2005) {
      return '1980s';
    }
    return yearToEra(track.releaseYear);
  }

  // 4. Check if title has any 4-digit year (1950-2026)
  const titleYearMatch = track.title.match(/\b(19[5-9]\d|20[0-2]\d)\b/);
  if (titleYearMatch) {
    return yearToEra(Number(titleYearMatch[1]));
  }

  // Default fallback for modern streaming libraries without year metadata
  return '2010s';
}

export interface FilteredPoolStats {
  filteredTracks: Track[];
  allCount: number;
  sharedCount: number;
  similarCount: number;
  genreCounts: Record<MusicGenreId, number>;
  eraCounts: Record<MusicEraId, number>;
}

/**
 * Computes the "Similar Music" subset of tracks:
 * - In Party Mode (2+ members):
 *   1. Exact shared songs (`favoritedBy.length >= 2`)
 *   2. Songs by artists that appear in 2+ different party members' libraries
 *   3. Songs in genres where 2+ members share strong overlap (if direct artist/song overlap is small)
 * - In Solo Mode (or 1 member):
 *   Songs by recurring favorite artists (artists with 2+ liked songs) or top genres.
 */
export function computeSimilarTracks(tracks: Track[], members: PartyMember[]): Set<string> {
  const similarIds = new Set<string>();
  if (tracks.length === 0) return similarIds;

  if (members.length >= 2) {
    // Map each normalized artist token -> set of memberIds who have tracks by this artist
    const artistToMembers = new Map<string, Set<string>>();
    // Map each genre -> set of memberIds who have tracks in this genre
    const genreToMembers = new Map<MusicGenreId, Set<string>>();

    for (const member of members) {
      for (const t of member.tracks) {
        for (const artistToken of normalizeArtistTokens(t)) {
          let set = artistToMembers.get(artistToken);
          if (!set) {
            set = new Set<string>();
            artistToMembers.set(artistToken, set);
          }
          set.add(member.id);
        }
        for (const g of inferTrackGenres(t)) {
          let gSet = genreToMembers.get(g);
          if (!gSet) {
            gSet = new Set<string>();
            genreToMembers.set(g, gSet);
          }
          gSet.add(member.id);
        }
      }
    }

    const sharedArtists = new Set<string>();
    for (const [artist, memberSet] of artistToMembers.entries()) {
      if (memberSet.size >= 2) {
        sharedArtists.add(artist);
      }
    }

    // 1. Add exact shared tracks + tracks by shared artists
    for (const track of tracks) {
      if ((track.favoritedBy?.length ?? 0) >= 2) {
        similarIds.add(track.id);
        continue;
      }
      const tokens = normalizeArtistTokens(track);
      if (tokens.some((tok) => sharedArtists.has(tok))) {
        similarIds.add(track.id);
      }
    }

    // 2. Also include tracks from genres liked by ALL (or >= 2) members if direct artist overlap is small
    if (similarIds.size < Math.min(15, tracks.length)) {
      const minGenreOverlap = Math.min(members.length, 2);
      const sharedGenres = new Set<MusicGenreId>();
      for (const [g, memberSet] of genreToMembers.entries()) {
        if (memberSet.size >= minGenreOverlap) {
          sharedGenres.add(g);
        }
      }
      for (const track of tracks) {
        const tGenres = inferTrackGenres(track);
        if (tGenres.some((g) => sharedGenres.has(g))) {
          similarIds.add(track.id);
        }
      }
    }
  } else {
    // Solo / 1-member mode: recurring artists (2+ tracks by same artist)
    const artistCounts = new Map<string, number>();
    for (const t of tracks) {
      for (const tok of normalizeArtistTokens(t)) {
        artistCounts.set(tok, (artistCounts.get(tok) ?? 0) + 1);
      }
    }
    for (const t of tracks) {
      const tokens = normalizeArtistTokens(t);
      if (tokens.some((tok) => (artistCounts.get(tok) ?? 0) >= 2)) {
        similarIds.add(t.id);
      }
    }
    if (similarIds.size === 0) {
      for (const t of tracks) {
        similarIds.add(t.id);
      }
    }
  }

  return similarIds;
}

/**
 * Evaluates a track pool against `PreGameFilterConfig` and returns both the filtered tracks
 * and live counts for every match mode, genre, and era option.
 */
export function evaluateTrackPoolFilters(
  tracks: Track[],
  members: PartyMember[],
  config: PreGameFilterConfig
): FilteredPoolStats {
  const similarTrackIds = computeSimilarTracks(tracks, members);

  const genreCounts: Record<MusicGenreId, number> = {
    pop: 0,
    rock: 0,
    hiphop: 0,
    electronic: 0,
    rnb: 0,
    metal: 0,
    latin: 0,
    country: 0,
    soundtrack: 0,
  };

  const eraCounts: Record<MusicEraId, number> = {
    'pre-80s': 0,
    '1980s': 0,
    '1990s': 0,
    '2000s': 0,
    '2010s': 0,
    '2020s': 0,
  };

  let sharedCount = 0;
  for (const t of tracks) {
    if ((t.favoritedBy?.length ?? 0) >= 2) {
      sharedCount++;
    }
  }

  // First filter by Match Mode ('all' | 'shared' | 'similar') to compute accurate Genre/Era counts within that mode
  const modeMatchedTracks = tracks.filter((t) => {
    if (config.matchMode === 'shared') {
      return (t.favoritedBy?.length ?? 0) >= 2;
    }
    if (config.matchMode === 'similar') {
      return similarTrackIds.has(t.id);
    }
    return true;
  });

  const trackMeta = new Map<string, { genres: MusicGenreId[]; era: MusicEraId }>();
  for (const t of modeMatchedTracks) {
    const genres = inferTrackGenres(t);
    const era = inferTrackEra(t);
    trackMeta.set(t.id, { genres, era });

    for (const g of genres) {
      genreCounts[g] = (genreCounts[g] ?? 0) + 1;
    }
    eraCounts[era] = (eraCounts[era] ?? 0) + 1;
  }

  const filteredTracks = modeMatchedTracks.filter((t) => {
    const meta = trackMeta.get(t.id);
    if (!meta) return false;

    if (config.genres.length > 0) {
      const hasGenre = meta.genres.some((g) => config.genres.includes(g));
      if (!hasGenre) return false;
    }

    if (config.eras.length > 0) {
      if (!config.eras.includes(meta.era)) return false;
    }

    return true;
  });

  return {
    filteredTracks,
    allCount: tracks.length,
    sharedCount,
    similarCount: similarTrackIds.size,
    genreCounts,
    eraCounts,
  };
}
