// -----------------------------------------------------------------------------
// Texts in English and French: names of the devices and features, the status
// of the Configuration screen, the answers of the buttons and the refusals of
// the commands. Never a credential or a token in any of them.
// -----------------------------------------------------------------------------

/** Both languages, from one template. */
const both = (en, fr) => ({ en, fr });

/** The text of one language (a refusal is a plain Error message). */
export const word = (text, language) =>
  typeof text === 'string' ? text : (text[language] ?? text.en);

/** "3 min", "45 s", "2 h". */
export function age(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 120) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 120 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
}

const join = (...texts) => ({
  en: texts
    .filter(Boolean)
    .map((t) => t.en)
    .join('\n'),
  fr: texts
    .filter(Boolean)
    .map((t) => t.fr)
    .join('\n'),
});

export const NAMES = {
  module: both('NASweb module', 'Module NASweb'),
  output: (n) => both(`output ${n}`, `sortie ${n}`),
  input: (n) => both(`input ${n}`, `entrée ${n}`),
  features: {
    power: both('Relay', 'Relais'),
    state: both('Relay state', 'État du relais'),
    input: both('Input active', 'Entrée active'),
    fault: both('Input fault or tamper', 'Défaut ou sabotage de l’entrée'),
    temperature: both('Temperature', 'Température'),
  },
};

export const featureName = (role, language) =>
  word(NAMES.features[role] ?? both(role, role), language);

const PROBLEMS = {
  'device:empty': both(
    'Type the IP address of the NASweb module, then save.',
    'Saisissez l’adresse IP du module NASweb, puis enregistrez.',
  ),
  'device:invalid': both(
    'The address of the module is not valid: an IP address, optionally with a port (192.168.1.50 or 192.168.1.50:443).',
    'L’adresse du module n’est pas valide : une adresse IP, éventuellement avec un port (192.168.1.50 ou 192.168.1.50:443).',
  ),
  username: both(
    'Type the login of the module (the one of its web page).',
    'Saisissez l’identifiant du module (celui de sa page web).',
  ),
  password: both('Type the password of the module.', 'Saisissez le mot de passe du module.'),
};

const REASONS = {
  unreachable: both('the module does not answer', 'le module ne répond pas'),
  timeout: both('the module stopped answering', 'le module ne répond plus'),
  http: both('the module answered with an error', 'le module a répondu par une erreur'),
  protocol: both(
    'the answer is not the one of a NASweb module',
    'la réponse n’est pas celle d’un module NASweb',
  ),
  storage: both(
    'the certificate could not be kept in /data, nothing was sent',
    'le certificat n’a pas pu être gardé dans /data, rien n’a été envoyé',
  ),
  stale: both('the configuration changed meanwhile', 'la configuration a changé entre-temps'),
};

export const reasonText = (kind) => REASONS[kind] ?? REASONS.unreachable;

export const T = {
  problem: (key) => PROBLEMS[key] ?? PROBLEMS['device:invalid'],
  connecting: both('Connecting to the module…', 'Connexion au module…'),
  unreachable: (kind) =>
    both(
      `Module unreachable: ${reasonText(kind).en}. Next try in a minute.`,
      `Module injoignable : ${reasonText(kind).fr}. Nouvel essai dans une minute.`,
    ),
  refused: both(
    'The module refused the login or the password: nothing more is sent to it. Correct them and save, or press "Test the connection".',
    'Le module a refusé l’identifiant ou le mot de passe : plus rien ne lui est envoyé. Corrigez-les et enregistrez, ou utilisez « Tester la connexion ».',
  ),
  certificate: (fingerprint) =>
    both(
      `The certificate of the module changed (now ${fingerprint}): nothing is sent to it. If you replaced or updated the module, press "Trust the device now answering".`,
      `Le certificat du module a changé (maintenant ${fingerprint}) : rien ne lui est envoyé. Si vous avez remplacé ou mis à jour le module, utilisez « Faire confiance à l’appareil qui répond ».`,
    ),
  otherDevice: (serial, known) =>
    both(
      `Another module answers at this address (serial ${serial}, ${known} expected): nothing is sent to it. If you replaced the module, press "Trust the device now answering".`,
      `Un autre module répond à cette adresse (série ${serial}, ${known} attendu) : rien ne lui est envoyé. Si vous avez remplacé le module, utilisez « Faire confiance à l’appareil qui répond ».`,
    ),
  unreadable: both(
    'The saved state of the integration (/data/nasweb.json) cannot be read: nothing is sent to the module, so that no unknown certificate is trusted. Press "Test the connection" to start again from scratch (the certificate of the module is then pinned again).',
    'L’état enregistré de l’intégration (/data/nasweb.json) est illisible : rien n’est envoyé au module, pour ne faire confiance à aucun certificat inconnu. Utilisez « Tester la connexion » pour repartir de zéro (le certificat du module est alors épinglé de nouveau).',
  ),
  noGladysAddress: both(
    'Type the IP address of the Gladys machine in "Address of Gladys": the module sends its states there, nothing arrives without it.',
    'Saisissez l’adresse IP de la machine Gladys dans « Adresse de Gladys » : le module y envoie ses états, rien n’arrive sans elle.',
  ),
  badGladysAddress: both(
    'The address of Gladys is not valid: an IP address or a host name, without a port.',
    'L’adresse de Gladys n’est pas valide : une adresse IP ou un nom d’hôte, sans port.',
  ),
  noReceiver: (status) =>
    both(
      `The push receiver is not running (${status}): no state can arrive. See the supervision block below.`,
      `Le récepteur des états ne tourne pas (${status}) : aucun état ne peut arriver. Voir le bloc de supervision plus bas.`,
    ),
  subscribeRefused: both(
    'The module refused the subscription to its states.',
    'Le module a refusé l’abonnement à ses états.',
  ),
  waiting: (address) =>
    both(
      `Connected to the module; waiting for its first status at ${address}. If nothing arrives, check that the module reaches this address (firewall, network).`,
      `Connecté au module ; en attente de son premier état sur ${address}. Si rien n’arrive, vérifiez que le module joint cette adresse (pare-feu, réseau).`,
    ),
  silent: (ago) =>
    both(
      `No status from the module for ${ago}: the devices are shown unreachable. The subscription is renewed every 10 minutes.`,
      `Aucun état du module depuis ${ago} : les appareils sont affichés injoignables. L’abonnement est renouvelé toutes les 10 minutes.`,
    ),
  wrongSource: (count, address) =>
    both(
      `${count} status(es) refused: they came from ${address || 'an unknown address'}, not from the module. If Docker hides the address of the module on this machine, turn off "Check the sender".`,
      `${count} état(s) refusé(s) : ils venaient de ${address || 'une adresse inconnue'}, pas du module. Si Docker masque l’adresse du module sur cette machine, désactivez « Vérifier l’expéditeur ».`,
    ),
  wrongSerial: (count) =>
    both(
      `${count} status(es) refused: another serial number than the module's.`,
      `${count} état(s) refusé(s) : un autre numéro de série que celui du module.`,
    ),
  connected: ({ name, serial, outputs, inputs, safe, commands, invalid }) =>
    join(
      both(
        `Connected to ${name || 'the module'} (${serial}): ${outputs} output(s), ${inputs} input(s), ${safe} output(s) declared safe; commands ${commands ? 'allowed' : 'off'}.`,
        `Connecté à ${name || 'le module'} (${serial}) : ${outputs} sortie(s), ${inputs} entrée(s), ${safe} sortie(s) déclarée(s) sûre(s) ; commandes ${commands ? 'autorisées' : 'désactivées'}.`,
      ),
      invalid > 0
        ? both(
            `${invalid} entry(ies) of "Outputs declared safe" ignored (an output index is a number).`,
            `${invalid} entrée(s) de « Sorties déclarées sûres » ignorée(s) (un numéro de sortie est un nombre).`,
          )
        : null,
    ),
  join,
};

export const TEST = {
  tooSoon: both(
    'Wait a few seconds between two tests.',
    'Attendez quelques secondes entre deux tests.',
  ),
  ok: ({ name, serial, port, address }) =>
    both(
      `The module answers: ${name || 'NASweb'}, serial ${serial}. Its states are sent to ${address ?? `port ${port ?? '?'} of Gladys`}.`,
      `Le module répond : ${name || 'NASweb'}, série ${serial}. Ses états sont envoyés à ${address ?? `le port ${port ?? '?'} de Gladys`}.`,
    ),
  failed: (text) => text,
};

export const TRUST = {
  nothing: both(
    'Nothing to trust: the module answering is the one known.',
    'Rien à approuver : le module qui répond est celui qui est connu.',
  ),
  confirm: ({ fingerprint, serial }) =>
    fingerprint && !serial
      ? both(
          `Now answering: certificate ${fingerprint}; its serial number was not read (nothing is sent to an unknown certificate). Trusting it sends the login to this device, then its serial number is compared with the known one. Press again within 60 s to trust exactly this certificate.`,
          `Répond maintenant : certificat ${fingerprint} ; son numéro de série n’a pas été lu (rien n’est envoyé à un certificat inconnu). L’approuver envoie l’identifiant à cet appareil, puis son numéro de série est comparé à celui connu. Appuyez de nouveau dans les 60 s pour approuver exactement ce certificat.`,
        )
      : both(
          `Now answering: serial ${serial}${fingerprint ? `, certificate ${fingerprint}` : ''}. Press again within 60 s to trust exactly this.`,
          `Répond maintenant : série ${serial}${fingerprint ? `, certificat ${fingerprint}` : ''}. Appuyez de nouveau dans les 60 s pour approuver exactement cela.`,
        ),
  done: both('Trusted. The module is read again now.', 'Approuvé. Le module est relu maintenant.'),
};

export const ERRORS = {
  unknownDevice: both(
    'Unknown device for this integration.',
    'Appareil inconnu de cette intégration.',
  ),
  readOnly: both('This value is read only.', 'Cette valeur est en lecture seule.'),
  unsafeOutput: both(
    'This output is not declared safe: add its number to "Outputs declared safe" to switch it.',
    'Cette sortie n’est pas déclarée sûre : ajoutez son numéro à « Sorties déclarées sûres » pour la commander.',
  ),
  commandsDisabled: both(
    'Commands are off: turn on "Allow the commands" in the configuration.',
    'Les commandes sont désactivées : activez « Autoriser les commandes » dans la configuration.',
  ),
  badValue: both('Only on (1) or off (0).', 'Seulement marche (1) ou arrêt (0).'),
  notConfigured: both('The integration is not configured.', 'L’intégration n’est pas configurée.'),
  refusedLogin: both(
    'The module refused the login: nothing sent.',
    'Le module a refusé l’identifiant : rien n’a été envoyé.',
  ),
  untrusted: both(
    'The module answering is not the known one (certificate or serial): nothing sent.',
    'Le module qui répond n’est pas celui qui est connu (certificat ou série) : rien n’a été envoyé.',
  ),
  noIdentity: both(
    'The module was never identified yet: nothing sent.',
    'Le module n’a encore jamais été identifié : rien n’a été envoyé.',
  ),
  noFreshState: both(
    'No recent status from the module (its states do not arrive): nothing sent, the result could not be confirmed.',
    'Aucun état récent du module (ses états n’arrivent pas) : rien n’a été envoyé, le résultat ne pourrait pas être confirmé.',
  ),
  unknownOutput: both(
    'The module no longer reports this output: nothing sent.',
    'Le module ne signale plus cette sortie : rien n’a été envoyé.',
  ),
  tooSlow: both(
    'The module answered too slowly to send the command in time: nothing sent.',
    'Le module a répondu trop lentement pour envoyer la commande à temps : rien n’a été envoyé.',
  ),
  unreachable: (kind) =>
    both(`Nothing sent: ${reasonText(kind).en}.`, `Rien n’a été envoyé : ${reasonText(kind).fr}.`),
  rejected: both(
    'The module answered that the command failed.',
    'Le module a répondu que la commande a échoué.',
  ),
  configChanged: both(
    'The configuration changed meanwhile: nothing sent.',
    'La configuration a changé entre-temps : rien n’a été envoyé.',
  ),
  unreadable: both(
    'The saved state of the integration cannot be read: nothing sent.',
    'L’état enregistré de l’intégration est illisible : rien n’a été envoyé.',
  ),
  loginRefusedSent: both(
    'The module refused the command (login refused).',
    'Le module a refusé la commande (identifiant refusé).',
  ),
  errorAnswer: (status) =>
    both(
      `The module answered with an error (HTTP ${status}): sent, without confirmation.`,
      `Le module a répondu par une erreur (HTTP ${status}) : envoyée, sans confirmation.`,
    ),
  unreadableAnswer: both(
    'The answer of the module cannot be read: sent, without confirmation.',
    'La réponse du module est illisible : envoyée, sans confirmation.',
  ),
  noAnswer: both(
    'Sent, without confirmation: the module did not answer in time.',
    'Envoyée, sans confirmation : le module n’a pas répondu à temps.',
  ),
  replaced: both(
    'Sent, then replaced by a newer command on this output: without confirmation.',
    'Envoyée, puis remplacée par une commande plus récente sur cette sortie : sans confirmation.',
  ),
  sentUnconfirmed: both(
    'Sent, without confirmation: the new state did not arrive in time.',
    'Envoyée, sans confirmation : le nouvel état n’est pas arrivé à temps.',
  ),
};
