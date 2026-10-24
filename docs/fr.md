# NASweb pour Gladys Assistant

Cette intégration amène un **module NASweb** (nasWebio, Chomtech) dans
Gladys, sur votre réseau local, sans cloud : ses **sorties relais**, ses
**entrées** et sa **sonde de température**.

Intégration non officielle, sans lien avec nasWebio. **Jamais testé avec un
vrai module** : elle suit l’API locale utilisée par la bibliothèque du
fabricant (webio-api, celle de l’intégration NASweb de Home Assistant).
Merci de dire sur le forum de Gladys si elle fonctionne avec le vôtre.

## Ce que vous obtenez

| Sur le module               | Dans Gladys                                                                 |
| --------------------------- | --------------------------------------------------------------------------- |
| Sortie relais déclarée sûre | Un interrupteur (marche / arrêt), seulement si vous autorisez les commandes |
| Autre sortie relais         | Son état, en lecture seule (aucune commande)                                |
| Entrée                      | « Entrée active » (1 active, 0 normale) et « Défaut ou sabotage » (1 ou 0)  |
| Sonde de température        | Température en °C, dès que le module a donné une valeur                     |

Les sorties et entrées apparaissent dans l’onglet **Découverte** dès que le
module a envoyé son premier état. Les zones d’alarme et le thermostat du
module ne sont pas proposés (ils arment, désarment ou chauffent : hors de
cette première version). L’API du module ne donne pas d’humidité : aucune
n’est proposée.

## Comment arrivent les états

Le module **pousse** ses états : il les envoie à une adresse qu’on lui a
donnée (un « abonnement aux états »). Le conteneur de l’intégration ne peut
rien recevoir du réseau : Gladys lance donc à côté un petit **récepteur**
(le conteneur `nasweb-push`, même image) et lui publie un port, choisi par
Gladys et affiché dans l’écran de configuration. L’intégration abonne
elle-même le module à `http://<adresse de Gladys>:<ce port>/nasweb/<secret>` :

- la partie secrète est aléatoire, générée une fois pour votre installation,
  gardée dans la configuration de Gladys (jamais affichée), et jamais écrite
  dans les journaux ;
- le récepteur n’accepte que cette adresse, la méthode POST, 32 Ko au plus
  et 120 envois par minute au plus ; tout le reste est refusé ;
- l’intégration n’accepte ensuite un état que s’il vient **de l’adresse du
  module** (option « Vérifier l’expéditeur des états ») et porte **son
  numéro de série**.

Si Docker masque la vraie adresse de l’expéditeur sur votre machine (tous
les états semblent alors venir d’une adresse du type 172.x.x.1, et l’état
le dit), désactivez « Vérifier l’expéditeur des états » : l’adresse secrète
et le numéro de série restent vérifiés.

Il n’y a pas d’autre moyen de lire les états : si aucun état n’arrive
pendant 90 secondes, les appareils sont affichés **injoignables**, le module
est relu (identité, abonnement) au plus une fois par minute, et l’abonnement
est renouvelé toutes les 10 minutes.

## Configuration

1. Donnez au module une **adresse IP fixe** dans votre box.
2. Dans Gladys, Intégrations → NASweb → Configuration :
   - **Adresse du module** : son adresse IP (celle de sa page web),
     éventuellement avec son port HTTPS, par exemple `192.168.1.50` ;
   - **Identifiant** et **Mot de passe** de la page web du module. Le mot de
     passe est gardé par Gladys dans sa base, jamais réaffiché, et envoyé
     seulement au module, comme il l’attend (une empreinte SHA-1, qui vaut le
     mot de passe pour le module : traitez-la comme tel) ;
   - **Adresse de Gladys** : l’adresse IP de la machine qui fait tourner
     Gladys, telle que le module la joint, par exemple `192.168.1.10` (sans
     port) ;
   - enregistrez.
3. Si la machine Gladys a un pare-feu, autorisez le port affiché dans
   l’écran de configuration (bloc du récepteur).
4. L’état indique « Connecté » dès que le premier état est arrivé. Les
   sorties et entrées sont alors dans l’onglet Découverte.

### Sorties relais : des interrupteurs seulement si elles sont déclarées sûres

Un relais peut commander une lampe, mais aussi une pompe, une chaudière, un
chauffage ou un portail. Un interrupteur est atteint par « tout éteindre »
des assistants vocaux, des scènes et du tableau de bord. Donc :

- seules les sorties listées dans **Sorties déclarées sûres** (leurs
  numéros, le paramètre NASWEB_OUTPUT de l’onglet Découverte, par exemple
  `1, 2, 5`) deviennent des interrupteurs ; ne listez que des charges qu’on
  peut couper ou allumer à tout moment ;
- toute autre sortie est son **état, en lecture seule** : aucune commande ne
  peut l’atteindre depuis Gladys ;
- **Autoriser les commandes** est désactivé par défaut : tant que vous ne
  l’activez pas, toute commande est refusée, même sur un interrupteur.

Une sortie retirée de la liste garde l’interrupteur déjà créé dans Gladys
(son historique est conservé), mais toute commande dessus est refusée.

### Quand une commande est acceptée

Une commande sur un interrupteur est refusée (rien n’est envoyé au module)
quand :

- « Autoriser les commandes » est désactivé, ou la sortie n’est pas
  déclarée sûre ;
- la valeur n’est pas exactement marche (1) ou arrêt (0) ;
- aucun état n’est arrivé du module depuis 90 secondes (le résultat ne
  pourrait pas être confirmé) ;
- le module a refusé l’identifiant, son certificat a changé, ou un autre
  numéro de série répond à son adresse ;
- une commande pour la même sortie est encore en cours ;
- le module répond trop lentement : la relecture de l’identité et la
  commande doivent partir dans les 3,5 secondes après le clic.

Avant chaque commande, l’intégration relit l’identité du module (son numéro
de série). La commande n’est confirmée que par un état du module montrant
l’état demandé dans les 4 secondes environ ; sinon Gladys affiche
« Envoyée, sans confirmation ».

## Sécurité

- Le module sert un certificat auto-signé. Son empreinte est **épinglée** à
  la première connexion (gardée dans `/data` avant que l’identifiant ne
  parte) ; un autre certificat est refusé avant tout envoi. Si vous avez
  remplacé ou mis à jour le module, l’état montre la nouvelle empreinte :
  appuyez deux fois en moins de 60 secondes sur **Faire confiance à
  l’appareil qui répond** (le premier appui montre seulement ce qui répond).
  Le même bouton accepte un nouveau numéro de série (module remplacé : ses
  sorties deviennent de nouveaux appareils).
- Un identifiant refusé arrête tout, même après un redémarrage : corrigez
  les identifiants et enregistrez, ou utilisez **Tester la connexion**.
  L’intégration ne réessaie jamais d’elle-même.
- Aucun identifiant, adresse secrète ou jeton n’est écrit dans les journaux,
  dans `/data` ou dans l’état.

## Boutons

- **Tester la connexion** : lit le module maintenant avec la configuration
  enregistrée (même après un identifiant refusé), l’abonne aux états, et dit
  ce qui a répondu. Au plus toutes les 10 secondes.
- **Faire confiance à l’appareil qui répond** : voir Sécurité.

## Dépannage

- _« en attente de son premier état »_ : le module ne joint pas Gladys.
  Vérifiez l’adresse de Gladys, le pare-feu de la machine Gladys, et que le
  module et Gladys sont sur le même réseau (ou routés). Passer par Gladys
  Plus ou un proxy pour ouvrir Gladys ne change rien : le module doit
  joindre l’adresse locale de la machine Gladys.
- _« état(s) refusé(s) : ils venaient de 172… »_ : voir « Comment arrivent
  les états ».
- _« Module injoignable »_ : vérifiez l’adresse du module et que sa page web
  s’ouvre.
