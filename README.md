# ODDSCOPE AI — appli téléphone

Appli web installable (sur l'écran d'accueil) qui analyse les cotes des bookmakers français et propose **un pari par match**, classé par **rendement attendu**, avec une note de 0 à 5 ★, la probabilité estimée, la cote juste et une explication.

- Les cotes viennent de [The Odds API](https://the-odds-api.com/) et sont téléchargées **directement depuis ton téléphone**, avec ta clé personnelle, qui reste stockée sur le téléphone. Ce dépôt ne contient **aucune clé ni aucune donnée personnelle**.
- Les statistiques des équipes (modèle Dixon-Coles, forme, domicile/extérieur) viennent de [football-data.co.uk](https://www.football-data.co.uk/). Elles sont recalculées chaque lundi par GitHub Actions (`tools/export_mobile.py`), avec une validation chronologique contre le marché.

## Installer sur le téléphone

1. Ouvre l'adresse de l'appli, celle qui apparaît dans *Settings → Pages* une fois la publication activée.
2. Ajoute-la à l'écran d'accueil :
   - **iPhone** (Safari) : Partager → « Sur l'écran d'accueil » ;
   - **Android** (Chrome) : menu ⋮ → « Installer l'application ».
3. Réglages → colle ta clé The Odds API → Paris → **Analyser les matchs**.

## Limites

Les étoiles mesurent la rentabilité théorique, pas la chance de gagner. Le rendement attendu est presque toujours négatif à cause de la marge des bookmakers. **Aucun gain n'est garanti.** L'appli ne place aucun pari.

Jeux d'argent : risque de perte et de dépendance, interdits aux mineurs. Joueurs Info Service : 09 74 75 13 13.
