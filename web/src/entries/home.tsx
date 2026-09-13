import { mount } from './mount';
import { Home } from '../home/Home';

// Links shared before the site had routes still land where they meant to.
const q = new URLSearchParams(window.location.search);
const tab = q.get('tab');
if (tab === 'record' || tab === 'watch') {
  window.location.replace('/' + tab + '/');
} else if (q.get('tx')) {
  window.location.replace('/verify/' + window.location.search);
} else {
  mount(<Home />);
}
