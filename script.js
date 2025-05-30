document.addEventListener('DOMContentLoaded', function() {
    const countdownDate = new Date('June 6, 2025 00:00:00').getTime(); // Data do lançamento

    const x = setInterval(function() {
        const now = new Date().getTime();
        const distance = countdownDate - now;

        const days = Math.floor(distance / (1000 * 60 * 60 * 24));
        const hours = Math.floor((distance % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        const minutes = Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((distance % (1000 * 60)) / 1000);

        document.getElementById('days').innerHTML = String(days).padStart(2, '0');
        document.getElementById('hours').innerHTML = String(hours).padStart(2, '0');
        document.getElementById('minutes').innerHTML = String(minutes).padStart(2, '0');
        document.getElementById('seconds').innerHTML = String(seconds).padStart(2, '0');

        if (distance < 0) {
            clearInterval(x);
            document.getElementById('countdown').innerHTML = '<h2 class="launched-message">Lançamento Iniciado!</h2>';
            document.querySelector('.main-title').innerHTML = 'Está no Ar!';
            document.querySelector('.subtitle').innerHTML = 'Aproveite tudo que preparamos para você!';
            document.querySelector('.call-to-action').style.display = 'none'; // Esconde o botão ou muda seu texto
            // Você pode redirecionar ou mostrar mais conteúdo aqui
        }
    }, 1000);
});