# §14a Netzentgelte (Modul 3) pour Gladys Assistant

**Intégration non officielle, sans lien avec un gestionnaire de réseau ni avec
la Bundesnetzagentur. Jamais testée avec un vrai contrat d'énergie Gladys
pour l'instant.**

En Allemagne, une pompe à chaleur, une borne de recharge, une climatisation ou
une batterie domestique de plus de 4,2 kW pilotée par le gestionnaire de réseau
au titre du §14a EnWG bénéficie d'un tarif réseau réduit. Avec le **Modul 3**
(en plus du Modul 1), le tarif réseau au kWh change aussi selon l'heure, sur
trois niveaux :

- **HT** (Hochlasttarif, haut), en pointe du soir par exemple ;
- **ST** (Standardtarif), le reste de la journée ;
- **NT** (Niedertarif, bas), la nuit ou à midi.

Chaque gestionnaire fixe ses plages, pour les trimestres de l'année où le
Modul 3 s'applique (souvent T1 et T4, parfois toute l'année) ; les autres
trimestres, le prix standard s'applique.

Cette intégration ajoute un **contrat d'énergie** à Gladys : elle tarife chaque
demi-heure de votre compteur au tarif réseau de votre gestionnaire en vigueur à
ce moment.

## Source des données et attribution

Les prix et les plages viennent de la **Par14a-Database (the78mole),
<https://github.com/the78mole/Par14a-Database>, licence : CC BY 4.0**, relevés
dans les grilles que les gestionnaires publient au titre de l'EnWG (données de
référence des gestionnaires : [vnbdigital.de](https://www.vnbdigital.de)).

- **Les grilles 2027 sont provisoires** (_vorläufig_) : les gestionnaires
  publient les définitives d'ici la fin de l'année. Le statut de l'intégration
  indique, par année, combien de grilles sont provisoires, la date de
  publication des données et leur dernière vérification ; le prix actuel d'un
  contrat affiche « (provisional) » et la date de relevé de la grille.
- Les données sont fournies sans garantie : **la grille de votre gestionnaire
  fait foi**. Un coût déjà calculé n'est pas recalculé quand une grille change
  (voir « Limites »).
- Modifications apportées aux données : les plages sont converties en niveaux
  par quart d'heure, la TVA et votre supplément sont ajoutés (détails dans
  `THIRD_PARTY_NOTICES.md`).

L'intégration télécharge les fichiers annuels de la page web de la
Par14a-Database (environ 1 Mo chacun, les années qu'elle liste, 6 au plus)
**une fois par jour**, avec une requête conditionnelle (rien n'est téléchargé
si rien n'a changé), et les garde dans son volume `/data`. La tarification
utilise ce qui est gardé : elle n'attend pas le réseau.

## Mise en place

1. Installez l'intégration depuis le store. Elle n'a pas de configuration :
   l'écran de configuration montre son statut et un bouton.
2. Trouvez votre gestionnaire de réseau (_Netzbetreiber_, sur votre facture
   d'électricité, pas votre fournisseur) : saisissez une partie de son nom, sa
   ville ou son code postal dans **Trouver mon gestionnaire de réseau** et
   appuyez. La réponse liste les gestionnaires trouvés avec leur
   **identifiant**, la grille de l'année (définitive ou provisoire, date du
   relevé), les prix HT / ST / NT (hors TVA) et les trimestres du Modul 3. Le
   code postal et la ville sont ceux du siège du gestionnaire, pas de votre
   logement.
3. Dans **Énergie → Contrats**, créez un contrat à partir du modèle **« Tarif
   réseau §14a Modul 3 (Allemagne) »** sur le compteur de votre appareil §14a
   (un compteur séparé avec le Modul 3, ou votre compteur principal), et
   remplissez :
   - **Gestionnaire de réseau (ID ou nom)** : l'identifiant donné par le bouton
     (ex. `7214`), ou le nom exact ; une partie de nom fonctionne seulement tant
     qu'elle désigne un seul gestionnaire ;
   - **TVA sur le tarif réseau** (19 % par défaut ; 0 garde les prix hors TVA) ;
   - **Supplément au kWh** (ct/kWh, 0 par défaut) : tout le reste facturé au
     kWh par votre fournisseur (énergie, prélèvements, taxe sur l'électricité),
     TVA comprise, ajouté tel que vous le saisissez ;
   - **Montant fixe par mois** (EUR, 0 par défaut, de 0 à 1000) : les prix de
     base par mois (réseau et fournisseur), TVA comprise ; Gladys le calcule.
     La réduction Modul 1 ne peut pas être déduite : pour la plupart des
     gestionnaires elle dépasse le prix de base réseau, et Gladys refuse un
     montant négatif. Laissez-la de côté ; les coûts affichés dépassent alors
     votre facture de cette réduction (voir « Limites »).

## Tarification d'une demi-heure

- Les plages sont des heures murales **allemandes** (CET en hiver, CEST en
  été), quel que soit le fuseau de Gladys. Le jour du passage à l'heure d'été,
  les quarts d'heure de 02:00 à 02:45 n'existent pas ; le jour du passage à
  l'heure d'hiver, l'heure de 02:00 à 03:00 a lieu deux fois, et les deux sont
  tarifées selon leur heure murale.
- Les plages des grilles sont au quart d'heure (17:15, 19:45…), les données du
  compteur à la demi-heure : chaque demi-heure est tarifée comme **deux quarts
  d'heure de la moitié de son énergie** (consommation supposée régulière dans
  la demi-heure).
- La grille utilisée est celle de l'année allemande du quart d'heure : la nuit
  du 31 décembre passe à la grille de l'année suivante à minuit, heure
  allemande.
- Coût = tarif réseau × (1 + TVA) + supplément, au kWh, en euros. Gladys ajoute
  le montant fixe mensuel.
- Le prix actuel (widget de prix du tableau de bord, condition « prix actuel »
  des scènes) est celui du quart d'heure en cours, avec l'heure du prochain
  changement et le prix suivant.

## Limites

- **Jours ouvrés** : quelques grilles limitent HT / NT aux jours ouvrés (la base
  ne le note que dans un commentaire). L'intégration tarife chaque jour avec les
  plages, et le signale dans le statut et dans la réponse de la recherche pour
  les gestionnaires concernés. Les jours fériés ne sont pas gérés non plus.
- **Données absentes** : une année absente de la base (2025 et avant, 2028 avant
  sa publication), un gestionnaire sans grille Modul 3 utilisable, ou un nom
  qui désigne plusieurs gestionnaires : les demi-heures ne sont pas tarifées
  (jamais tarifées à 0) ; Gladys réessaie à son passage suivant, et rattrape
  quand les données arrivent. Le statut compte les contrats dont le
  gestionnaire est introuvable.
- **Jour de facturation** : Gladys demande les coûts d'une période de
  facturation à la fois, tout ou rien. Avec un jour de facturation autre que
  le 1er, les demi-heures de décembre d'une période qui passe le 1er janvier
  attendent aussi la grille de l'année suivante.
- **Réduction Modul 1** : elle ne peut pas être saisie (Gladys refuse un
  montant fixe négatif) ; les coûts affichés la dépassent d'autant.
- **Mises à jour des grilles** : quand une grille provisoire devient
  définitive, les demi-heures déjà tarifées gardent leur coût.
- **Libellés** : une demi-heure dont les deux quarts d'heure diffèrent porte
  les deux, par exemple `ST/HT` pour 17:00-17:30 avec HT dès 17:15.
- Les prix de la base sont les tarifs réseau seuls : le prix de l'énergie de
  votre fournisseur, les prélèvements et les taxes vont dans le supplément.

## Messages de statut

- « PROVISOIRES » / « dont n provisoires » : la part de grilles provisoires
  d'une année.
- « Dernière vérification en échec … ; nouvel essai … » : la page n'a pas
  répondu (nouvel essai après 5, 15, 30, 60 minutes, puis toutes les 3 heures),
  a demandé de ralentir (429 : pause du temps demandé, entre 1 minute et
  6 heures), ou a envoyé un fichier illisible (les données gardées restent
  utilisées).
- « 2028 : aucune grille publiée pour l'instant » : la source a ouvert une
  année sans grille ; ce n'est pas une erreur. « 2027 : le fichier a été
  refusé (…) » : un nouveau fichier de cette année est illisible ; les données
  gardées pour elle restent utilisées, les autres années sont mises à jour, et
  le fichier est redemandé (de façon conditionnelle) à la vérification
  quotidienne suivante.
- « Les données ne peuvent pas être écrites dans /data » : une écriture a
  échoué ou a pris plus de 10 secondes ; les données restent en mémoire et
  sont retéléchargées après un redémarrage.
- « Les données gardées dans /data sont illisibles » : le volume de
  l'intégration est abîmé ; relu toutes les 10 secondes, rien n'est téléchargé
  en attendant.

## Vie privée

Aucun compte, aucune donnée personnelle : l'intégration ne télécharge que des
fichiers publics, avec son propre User-Agent. Les champs de votre contrat
restent dans Gladys.
