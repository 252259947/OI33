import { addPage, NamedPage } from '@hydrooj/ui-default';
import { installScoreboardUsability } from './scoreboard-usability';
import './scoreboard-usability.css';

addPage(new NamedPage(['contest_scoreboard', 'homework_scoreboard'], () => {
    installScoreboardUsability();
}));
